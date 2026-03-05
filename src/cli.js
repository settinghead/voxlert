#!/usr/bin/env node

import { readFileSync, existsSync, watchFile, rmSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { createInterface } from "readline";
import select from "@inquirer/select";
import confirm from "@inquirer/confirm";
import { loadConfig, saveConfig, FALLBACK_PHRASES } from "./config.js";
import { generatePhrase } from "./llm.js";
import { speakPhrase } from "./audio.js";
import { showOverlay } from "./overlay.js";
import { loadPack, listPacks } from "./packs.js";
import { formatCost, resetUsage } from "./cost.js";
import { CONFIG_PATH, STATE_DIR, LOG_FILE, MAIN_LOG_FILE, HOOK_DEBUG_LOG } from "./paths.js";
import { processHookEvent } from "./voiceforge.js";
import { unregisterHooks, removeSkill } from "./hooks.js";
import { unregisterCursorHooks } from "./cursor-hooks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const HELP = `
voiceforge v${pkg.version} — Game character voice notifications for Claude Code, Cursor, and OpenClaw

Usage:
  voiceforge setup               Interactive setup wizard (LLM, voice, TTS, hooks)
  voiceforge hook                Process a hook event from stdin (used by Claude Code hooks)
  voiceforge cursor-hook         Process a hook event from stdin (used by Cursor hooks)
  voiceforge config              Show current configuration
  voiceforge config show         Show current configuration
  voiceforge config set <k> <v>  Set a config value (supports categories.X dot notation)
  voiceforge config path         Print config file path
  voiceforge log                  Stream activity log (tail -f style)
  voiceforge log path            Print activity log file path
  voiceforge log error-path      Print error/fallback log file path
  voiceforge log on | off        Enable or disable activity logging
  voiceforge log error on | off  Enable or disable error (fallback) logging
  voiceforge voice               Interactive voice pack picker
  voiceforge pack list           List available voice packs
  voiceforge pack show           Show active pack details
  voiceforge pack use <pack-id>  Switch active voice pack
  voiceforge volume              Show current volume and prompt for new value
  voiceforge volume <0-100>      Set playback volume (0 = mute, 100 = max)
  voiceforge notification        Choose notification style (popup / system / off)
  voiceforge test "<text>"       Run full pipeline: LLM -> TTS -> audio playback
  voiceforge cost                Show accumulated token usage and estimated cost
  voiceforge cost reset          Clear the usage log
  voiceforge uninstall           Remove hooks from Claude Code & Cursor, optionally config/cache
  voiceforge help                Show this help message
  voiceforge --version           Show version
`.trim();

// Cursor hook event name (camelCase) -> VoiceForge internal name (PascalCase)
const CURSOR_TO_VOICEFORGE_EVENT = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  stop: "Stop",
  postToolUseFailure: "PostToolUseFailure",
  preCompact: "PreCompact",
};

function getLastAssistantFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const raw = readFileSync(transcriptPath, "utf-8");
    if (!raw || !raw.trim()) return null;
    const slice = raw.length > 500 ? raw.slice(-500) : raw;
    return slice.trim();
  } catch {
    return null;
  }
}

async function runCursorHook() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.stdout.write("{}\n");
    return;
  }
  const cursorEvent = payload.hook_event_name || "";
  const ourEvent = CURSOR_TO_VOICEFORGE_EVENT[cursorEvent];
  if (!ourEvent) {
    process.stdout.write("{}\n");
    return;
  }
  const workspaceRoots = payload.workspace_roots;
  const cwd = Array.isArray(workspaceRoots) && workspaceRoots[0] ? workspaceRoots[0] : "";
  const translated = {
    ...payload,
    hook_event_name: ourEvent,
    cwd,
    source: "cursor",
  };
  if (ourEvent === "Stop" && payload.transcript_path) {
    const last = getLastAssistantFromTranscript(payload.transcript_path);
    if (last) translated.last_assistant_message = last;
  }
  if (ourEvent === "PostToolUseFailure" && payload.error_message) {
    translated.error_message = payload.error_message;
  }
  try {
    await processHookEvent(translated);
  } catch {
    // best-effort: still return {} so Cursor doesn't error
  }
  process.stdout.write("{}\n");
}

const TAIL_LINES = 100;

function tailLog() {
  if (!existsSync(MAIN_LOG_FILE)) {
    console.log("(No activity log yet. Logging is on by default; events will appear here.)");
    console.log("Path: " + MAIN_LOG_FILE);
  }
  let lastSize = 0;
  function readNew() {
    try {
      const content = readFileSync(MAIN_LOG_FILE, "utf-8");
      if (content.length < lastSize) lastSize = 0;
      if (content.length > lastSize) {
        const newPart = content.slice(lastSize);
        process.stdout.write(newPart);
        lastSize = content.length;
      }
    } catch {
      // file may have been removed
    }
  }
  function init() {
    try {
      const content = readFileSync(MAIN_LOG_FILE, "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      const toShow = lines.slice(-TAIL_LINES);
      toShow.forEach((l) => console.log(l));
      lastSize = content.length;
    } catch {
      lastSize = 0;
    }
  }
  init();
  watchFile(MAIN_LOG_FILE, { interval: 500 }, (cur, prev) => {
    readNew();
  });
  // Keep process alive
  process.stdin.resume();
}

function setLoggingOnOff(value) {
  const config = loadConfig(process.cwd());
  config.logging = value === "on" || value === true;
  saveConfig(config);
  console.log("Activity logging: " + (config.logging ? "on" : "off"));
}

function setErrorLogOnOff(value) {
  const config = loadConfig(process.cwd());
  config.error_log = value === "on" || value === true;
  saveConfig(config);
  console.log("Error (fallback) logging: " + (config.error_log ? "on" : "off"));
}

function maskKey(key) {
  if (!key || typeof key !== "string") return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

function showConfig() {
  const config = loadConfig(process.cwd());
  const display = { ...config };
  if (display.llm_api_key) {
    display.llm_api_key = maskKey(display.llm_api_key);
  }
  if (display.openrouter_api_key) {
    display.openrouter_api_key = maskKey(display.openrouter_api_key);
  }
  console.log(JSON.stringify(display, null, 2));
}

function configSet(key, value) {
  if (!key) {
    console.error("Usage: voiceforge config set <key> <value>");
    process.exit(1);
  }

  // Auto-coerce booleans and numbers
  let coerced = value;
  if (value === "true") coerced = true;
  else if (value === "false") coerced = false;
  else if (value !== "" && !isNaN(Number(value))) coerced = Number(value);

  const config = loadConfig(process.cwd());

  // Support dot notation for categories (e.g. categories.notification)
  const parts = key.split(".");
  if (parts.length === 2) {
    if (!config[parts[0]] || typeof config[parts[0]] !== "object") {
      config[parts[0]] = {};
    }
    config[parts[0]][parts[1]] = coerced;
  } else {
    config[key] = coerced;
  }

  saveConfig(config);
  console.log(`Set ${key} = ${JSON.stringify(coerced)}`);
}

async function testPipeline(text, pack) {
  if (!text) {
    console.error("Usage: voiceforge test \"<text>\"");
    process.exit(1);
  }

  const config = loadConfig(process.cwd());
  if (!pack) pack = loadPack(config);

  console.log(`Input: ${text}`);
  console.log(`Pack: ${pack.name} (${pack.id}), echo: ${pack.echo !== false}`);
  console.log("Generating phrase via LLM...");

  const context = `${text}`;
  const result = await generatePhrase(context, config, pack.style, pack.llm_temperature, pack.examples);

  let phrase;
  if (result.phrase) {
    phrase = result.phrase;
    console.log(`LLM phrase: ${phrase}`);
    if (result.usage) {
      console.log(`Tokens: ${result.usage.total_tokens || 0} (${result.usage.prompt_tokens || 0} prompt + ${result.usage.completion_tokens || 0} completion)`);
    }
  } else {
    console.log(`LLM failed (${result.fallbackReason}), using raw text as phrase.`);
    phrase = text;
  }

  console.log("Sending to TTS...");
  showOverlay(phrase, {
    category: "notification",
    packName: pack.name,
    packId: pack.id || (config.active_pack || "sc2-adjutant"),
    prefix: "Test",
    config,
    overlayColors: pack.overlay_colors,
  });
  await speakPhrase(phrase, config, pack);
  console.log("Done.");
}

async function showCost() {
  console.log(await formatCost());
}

function costReset() {
  resetUsage();
  console.log("Usage log cleared.");
}

function packList() {
  const packs = listPacks();
  const config = loadConfig(process.cwd());
  const active = config.active_pack || "";
  if (packs.length === 0) {
    console.log("No voice packs found.");
    return;
  }
  const randomMarker = active === "random" ? " (active)" : "";
  console.log(`  random — Random (picks a different voice each time)${randomMarker}`);
  for (const p of packs) {
    const marker = p.id === active ? " (active)" : "";
    console.log(`  ${p.id} — ${p.name}${marker}`);
  }
}

async function voicePick() {
  const packs = listPacks();
  if (packs.length === 0) {
    console.log("No voice packs found.");
    return;
  }

  const config = loadConfig(process.cwd());
  const active = config.active_pack || "";

  const choices = [
    {
      name: active === "random" ? "Random (active)" : "Random",
      value: "random",
      description: "Picks a different voice each time",
    },
    ...packs.map((p) => ({
      name: p.id === active ? `${p.name} (active)` : p.name,
      value: p.id,
      description: p.id,
    })),
  ];

  const chosen = await select({
    message: "Select a voice pack",
    choices,
    default: active || undefined,
  });

  if (chosen === active) {
    const label = chosen === "random" ? "Random" : packs.find((p) => p.id === chosen).name;
    console.log(`Already using: ${label}`);
    return;
  }

  config.active_pack = chosen;
  saveConfig(config);
  if (chosen === "random") {
    console.log("Switched to: Random");
  } else {
    const match = packs.find((p) => p.id === chosen);
    console.log(`Switched to: ${match.name} (${chosen})`);
  }
  await greetWithVoice();
}

function packShow() {
  const config = loadConfig(process.cwd());
  const pack = loadPack(config);
  console.log(JSON.stringify(pack, null, 2));
}

async function greetWithVoice() {
  const config = loadConfig(process.cwd());
  const pack = loadPack(config);
  await testPipeline(`You have chosen '${pack.name}' as the new voice. It is now activated.`, pack);
}

async function packUse(packId) {
  if (!packId) {
    console.error("Usage: voiceforge pack use <pack-id>");
    process.exit(1);
  }
  if (packId === "random") {
    const config = loadConfig(process.cwd());
    config.active_pack = "random";
    saveConfig(config);
    console.log("Switched to pack: Random (picks a different voice each time)");
    return;
  }
  const packs = listPacks();
  const match = packs.find((p) => p.id === packId);
  if (!match) {
    console.error(`Pack "${packId}" not found. Available packs:`);
    console.error("  random — Random (picks a different voice each time)");
    for (const p of packs) console.error(`  ${p.id} — ${p.name}`);
    process.exit(1);
  }
  const config = loadConfig(process.cwd());
  config.active_pack = packId;
  saveConfig(config);
  console.log(`Switched to pack: ${match.name} (${packId})`);
  await greetWithVoice();
}

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function setVolume(val) {
  let num;
  if (val == null || val === "") {
    const config = loadConfig(process.cwd());
    const current = Math.round((config.volume ?? 0.5) * 100);
    const answer = await askLine(`Current volume: ${current}. Enter new volume (0-100): `);
    num = Number(answer);
  } else {
    num = Number(val);
  }

  if (isNaN(num) || num < 0 || num > 100) {
    console.error("Volume must be a number between 0 and 100.");
    process.exit(1);
  }

  const config = loadConfig(process.cwd());
  config.volume = num / 100;
  saveConfig(config);
  console.log(`Volume set to ${num}%`);
}

/** Notification style: "custom" | "system" | "off". Platform-specific choices via inquirer. */
async function notificationPick() {
  const config = loadConfig(process.cwd());
  const platform = process.platform;
  const currentOverlay = config.overlay !== false;
  const currentStyle = config.overlay_style || "custom";

  const choices =
    platform === "darwin"
      ? [
          { value: "custom", name: "Custom overlay (popup)", description: "In-app style popup with gradient and icon" },
          { value: "system", name: "System notification", description: "macOS Notification Center" },
          { value: "off", name: "Off", description: "No popup, voice only" },
        ]
      : [
          { value: "system", name: "System notification", description: platform === "win32" ? "Windows toast" : "notify-send / system tray" },
          { value: "off", name: "Off", description: "No popup, voice only" },
        ];

  const currentValue =
    !currentOverlay ? "off" : platform === "darwin" ? currentStyle : currentOverlay ? "system" : "off";

  const chosen = await select({
    message: "Notification style",
    choices,
    default: currentValue,
  });

  config.overlay = chosen !== "off";
  if (chosen !== "off") config.overlay_style = chosen;
  saveConfig(config);

  const labels = { custom: "Custom overlay", system: "System notification", off: "Off" };
  console.log(`Notifications: ${labels[chosen]}`);
}

async function runUninstall() {
  console.log("Removing VoiceForge hooks and skill...\n");

  const claudeRemoved = unregisterHooks();
  if (claudeRemoved > 0) {
    console.log(`  Removed ${claudeRemoved} hook(s) from ~/.claude/settings.json`);
  }

  const cursorRemoved = unregisterCursorHooks();
  if (cursorRemoved > 0) {
    console.log(`  Removed ${cursorRemoved} hook(s) from ~/.cursor/hooks.json`);
  }

  const skillRemoved = removeSkill();
  if (skillRemoved) {
    console.log("  Removed voiceforge-config skill");
  }

  if (claudeRemoved === 0 && cursorRemoved === 0 && !skillRemoved) {
    console.log("  No VoiceForge hooks or skill were found.");
  }

  if (existsSync(STATE_DIR)) {
    const removeData = await confirm({
      message: `Remove config and cache (${STATE_DIR})?`,
      default: false,
    });
    if (removeData) {
      rmSync(STATE_DIR, { recursive: true });
      console.log(`  Removed ${STATE_DIR}`);
    }
  }

  console.log("\nUninstall complete. You can still run 'voiceforge' if installed via npm; run 'npm uninstall -g @settinghead/voiceforge' to remove the CLI.");
}

// --- Main ---
(async () => {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const sub = args[1] || "";

  // First-run: auto-launch setup wizard if ~/.voiceforge/ doesn't exist
  const skipWizardCmds = ["setup", "hook", "cursor-hook", "log", "notification", "uninstall", "help", "--help", "-h", "--version", "-v"];
  if (!skipWizardCmds.includes(cmd) && !existsSync(STATE_DIR)) {
    console.log("Welcome to VoiceForge! Let's get you set up.\n");
    const { runSetup } = await import("./setup.js");
    await runSetup();
    return;
  }

  switch (cmd) {
    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup();
      break;
    }

    case "hook": {
      // Read stdin and process as a hook event
      let input = "";
      for await (const chunk of process.stdin) { input += chunk; }
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(HOOK_DEBUG_LOG, `[${new Date().toISOString()}] voiceforge hook stdin received length=${input.length} raw=${input.slice(0, 200)}\n`);
        const eventData = JSON.parse(input);
        if (!eventData.source) eventData.source = "claude";
        appendFileSync(HOOK_DEBUG_LOG, `[${new Date().toISOString()}] voiceforge hook parsed eventData ${JSON.stringify(eventData)}\n`);
        await processHookEvent(eventData);
      } catch (err) {
        try {
          mkdirSync(STATE_DIR, { recursive: true });
          appendFileSync(HOOK_DEBUG_LOG, `[${new Date().toISOString()}] voiceforge hook parse/process error ${err && err.message}\n`);
        } catch {}
        // invalid input — ignore silently
      }
      break;
    }

    case "cursor-hook": {
      await runCursorHook();
      break;
    }

    case "config":
      if (sub === "set") {
        configSet(args[2], args.slice(3).join(" "));
      } else if (sub === "path") {
        console.log(CONFIG_PATH);
      } else {
        showConfig();
      }
      break;

    case "log": {
      const logSub = sub;
      const logArg = args[2];
      if (logSub === "path") {
        console.log(MAIN_LOG_FILE);
      } else if (logSub === "error-path") {
        console.log(LOG_FILE);
      } else if (logSub === "on" || logSub === "off") {
        setLoggingOnOff(logSub);
      } else if (logSub === "error" && (logArg === "on" || logArg === "off")) {
        setErrorLogOnOff(logArg);
      } else if (!logSub || logSub === "tail") {
        tailLog();
      } else {
        console.log("Activity log: " + MAIN_LOG_FILE);
        console.log("Error log: " + LOG_FILE);
        console.log("Use: voiceforge log          (stream activity log)");
        console.log("      voiceforge log path    (activity log path)");
        console.log("      voiceforge log error-path");
        console.log("      voiceforge log on | off");
        console.log("      voiceforge log error on | off");
      }
      break;
    }

    case "pack":
      if (sub === "list" || sub === "ls") {
        packList();
      } else if (sub === "show") {
        packShow();
      } else if (sub === "use") {
        await packUse(args[2]);
      } else {
        packList();
      }
      break;

    case "volume":
    case "vol":
      await setVolume(args[1]);
      break;

    case "notification":
    case "notify":
      await notificationPick();
      break;

    case "voice":
    case "voices":
      await voicePick();
      break;

    case "test":
      await testPipeline(args.slice(1).join(" "));
      break;

    case "cost":
      if (sub === "reset") {
        costReset();
      } else {
        await showCost();
      }
      break;

    case "uninstall":
      await runUninstall();
      break;

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    case "--version":
    case "-v":
      console.log(pkg.version);
      break;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
})();
