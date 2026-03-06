/**
 * Interactive setup wizard for VoiceForge.
 * Handles LLM provider selection, API key input, voice pack picking,
 * TTS server detection, and Claude Code hook registration.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import select from "@inquirer/select";
import checkbox from "@inquirer/checkbox";
import input from "@inquirer/input";
import confirm from "@inquirer/confirm";
import { loadConfig, saveConfig, ensureConfig } from "./config.js";
import { listPacks } from "./packs.js";
import { CONFIG_PATH, PACKS_DIR, CACHE_DIR, IS_NPM_GLOBAL, BUNDLED_PACKS_DIR, SCRIPT_DIR } from "./paths.js";
import { PACK_REGISTRY, DEFAULT_DOWNLOAD_PACK_IDS, getPackRegistryBaseUrl } from "./pack-registry.js";
import { LLM_PROVIDERS, getProvider } from "./providers.js";
import { registerHooks, installSkill, unregisterHooks, hasVoiceForgeHooks, hasInstalledSkill, removeSkill } from "./hooks.js";
import { registerCursorHooks, unregisterCursorHooks, hasCursorHooks } from "./cursor-hooks.js";
import { registerCodexNotify, getCodexConfigPath, unregisterCodexNotify, hasCodexNotify } from "./codex-config.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

function color(text, code) {
  return `${code}${text}${ANSI.reset}`;
}

function formatCurrentConfig(config) {
  const provider = getProvider(config.llm_backend || "openrouter");
  const providerLabel = config.llm_api_key
    ? `${provider ? provider.name : (config.llm_backend || "openrouter")} (${config.llm_model || provider?.defaultModel || "default"})`
    : "Fallback only";
  const ttsLabel = config.tts_backend || "chatterbox";
  const voiceLabel = config.active_pack || "sc2-adjutant";
  const platforms = [];
  if (hasVoiceForgeHooks() || hasInstalledSkill()) platforms.push("Claude");
  if (hasCursorHooks()) platforms.push("Cursor");
  if (hasCodexNotify()) platforms.push("Codex");
  return [
    `${color("Current", ANSI.dim)} ${providerLabel}`,
    `${color("Voice", ANSI.dim)}   ${voiceLabel}`,
    `${color("TTS", ANSI.dim)}     ${ttsLabel}`,
    `${color("Hooks", ANSI.dim)}   ${platforms.length > 0 ? platforms.join(", ") : "None"}`,
  ];
}

function printSetupHeader(config) {
  console.log("");
  console.log(color("=== VoiceForge Setup ===", ANSI.bold));
  console.log("");
  for (const line of formatCurrentConfig(config)) {
    console.log(`  ${line}`);
  }
  console.log("");
}

function printStep(number, title) {
  console.log(color(`Step ${number}/6: ${title}`, ANSI.bold));
  console.log("");
}

function printStatus(label, value) {
  console.log(`  ${color(label, ANSI.dim)} ${value}`);
}

function printSuccess(message) {
  console.log(`  ${color("OK", ANSI.green)} ${message}`);
}

function printWarning(message) {
  console.log(`  ${color("->", ANSI.yellow)} ${message}`);
}

/**
 * Probe a URL with a GET request. Resolves true if any response comes back.
 */
function probeUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch {
      return resolve(false);
    }
    const reqFn = urlObj.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(urlObj, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Validate an API key by making a lightweight request to the provider.
 */
function validateApiKey(providerId, apiKey) {
  return new Promise((resolve) => {
    const provider = getProvider(providerId);
    if (!provider) return resolve({ ok: false, error: "Unknown provider" });

    let url;
    let options;

    const base = provider.baseUrl.replace(/\/+$/, "");

    if (provider.format === "anthropic") {
      // Anthropic: POST to /v1/messages with a tiny request
      url = new URL(`${base}/v1/messages`);
      const authHeaders = provider.authHeader(apiKey);
      const payload = JSON.stringify({
        model: provider.defaultModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      options = {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 8000,
      };
      const req = httpsRequest(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 401) return resolve({ ok: false, error: "Invalid API key" });
          if (res.statusCode === 403) return resolve({ ok: false, error: "API key lacks permissions" });
          resolve({ ok: res.statusCode < 500 });
        });
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Timeout" }); });
      req.write(payload);
      req.end();
    } else {
      // OpenAI-compatible: GET /models
      url = new URL(`${base}/models`);
      const authHeaders = provider.authHeader(apiKey);
      options = {
        method: "GET",
        headers: { ...authHeaders },
        timeout: 8000,
      };
      const reqFn = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = reqFn(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 401) return resolve({ ok: false, error: "Invalid API key" });
          if (res.statusCode === 403) return resolve({ ok: false, error: "API key lacks permissions" });
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
        });
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Timeout" }); });
      req.end();
    }
  });
}

/**
 * Fetch a URL and return the response body as a Buffer.
 * Rejects on non-2xx or network error.
 */
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const reqFn = urlObj.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(urlObj, { method: "GET", timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

/**
 * Download a voice pack from the registry base URL into PACKS_DIR/<id>/.
 * Writes pack.json and voice.wav. Resolves on success, rejects on fetch/write error.
 */
async function downloadPack(packId, baseUrl) {
  const dir = join(PACKS_DIR, packId);
  mkdirSync(dir, { recursive: true });

  const packUrl = `${baseUrl.replace(/\/$/, "")}/${packId}/pack.json`;
  const voiceUrl = `${baseUrl.replace(/\/$/, "")}/${packId}/voice.wav`;

  const [packBuf, voiceBuf] = await Promise.all([
    fetchUrl(packUrl),
    fetchUrl(voiceUrl),
  ]);

  writeFileSync(join(dir, "pack.json"), packBuf);
  writeFileSync(join(dir, "voice.wav"), voiceBuf);
}

/**
 * Copy bundled packs to the user's packs directory (for npm global installs).
 */
function ensurePacks() {
  if (!IS_NPM_GLOBAL) return;
  if (!existsSync(BUNDLED_PACKS_DIR)) return;

  mkdirSync(PACKS_DIR, { recursive: true });
  for (const name of readdirSync(BUNDLED_PACKS_DIR)) {
    const src = join(BUNDLED_PACKS_DIR, name);
    const dest = join(PACKS_DIR, name);
    mkdirSync(dest, { recursive: true });

    const packJson = join(src, "pack.json");
    if (existsSync(packJson)) {
      copyFileSync(packJson, join(dest, "pack.json"));
    }
    const voiceWav = join(src, "voice.wav");
    if (existsSync(voiceWav) && !existsSync(join(dest, "voice.wav"))) {
      copyFileSync(voiceWav, join(dest, "voice.wav"));
    }
  }
}

export async function runSetup() {
  // Ensure config exists
  ensureConfig();
  ensurePacks();
  mkdirSync(CACHE_DIR, { recursive: true });

  const config = loadConfig();
  const currentBackend = config.llm_backend || "openrouter";
  const currentProvider = getProvider(currentBackend);
  const currentModel = config.llm_model || currentProvider?.defaultModel || "default";
  printSetupHeader(config);

  // --- Step 1: LLM Provider ---
  printStep(1, "LLM Provider");

  const providerChoices = [
    ...Object.entries(LLM_PROVIDERS).map(([id, p]) => ({
      name: [
        p.name,
        id === currentBackend ? `(current: ${currentModel})` : "",
        id === "openrouter" ? "(recommended)" : "",
        "—",
        p.description,
      ].filter(Boolean).join(" "),
      value: id,
    })),
    {
      name: currentBackend === "local" || !config.llm_api_key
        ? "Skip (current: fallback only) — fallback phrases only, no API key needed"
        : "Skip — fallback phrases only, no API key needed",
      value: "skip",
    },
  ];

  const chosenProvider = await select({
    message: "Which LLM provider would you like to use?",
    choices: providerChoices,
    default: currentBackend !== "local" ? currentBackend : "openrouter",
  });

  let apiKey = null;

  if (chosenProvider !== "skip") {
    config.llm_backend = chosenProvider;
    const provider = getProvider(chosenProvider);

    // --- Step 2: API Key ---
    console.log("");
    printStep(2, "API Key");
    printStatus("Get a key at:", provider.signupUrl);
    console.log("");

    const existingKey = config.llm_api_key ?? config.openrouter_api_key ?? "";
    const maskedExisting = existingKey
      ? `${existingKey.slice(0, 4)}…${existingKey.slice(-4)}`
      : "";

    apiKey = await input({
      message: "Paste your API key:",
      default: existingKey || undefined,
      transformer: (val) => {
        if (!val) return maskedExisting || "";
        if (val === existingKey) return maskedExisting;
        if (val.length <= 8) return "****";
        return val.slice(0, 4) + "…" + val.slice(-4);
      },
    });

    if (apiKey) {
      process.stdout.write("  Validating key... ");
      const result = await validateApiKey(chosenProvider, apiKey);
      if (result.ok) {
        console.log(color("valid!", ANSI.green) + "\n");
      } else {
        console.log(`could not validate (${result.error || "unknown error"})`);
        const proceed = await confirm({
          message: "Use this key anyway?",
          default: true,
        });
        if (!proceed) {
          apiKey = null;
          printWarning("Skipped. Set it later with: voiceforge config set llm_api_key <key>");
          console.log("");
        } else {
          console.log("");
        }
      }

      if (apiKey) {
        config.llm_api_key = apiKey;
        // Clear legacy field if using the new unified field
        if (chosenProvider === "openrouter") {
          config.openrouter_api_key = apiKey;
        }
      } else {
        config.llm_api_key = null;
        config.openrouter_api_key = null;
      }
    } else {
      config.llm_api_key = null;
      config.openrouter_api_key = null;
    }

    // Set default model for chosen provider
    if (!config.llm_model && !config.openrouter_model) {
      config.llm_model = provider.defaultModel;
    }
  } else {
    config.llm_api_key = null;
    config.openrouter_api_key = null;
    console.log("");
    printWarning("Using fallback phrases from the voice pack.");
    console.log("");
  }

  // --- Step 3: Download voice packs (from GitHub) ---
  console.log("");
  printStep(3, "Download voice packs");
  printStatus("Source", "VoiceForge GitHub repo");
  console.log("");

  mkdirSync(PACKS_DIR, { recursive: true });
  const existingPackIds = new Set();
  try {
    for (const entry of readdirSync(PACKS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(PACKS_DIR, entry.name, "pack.json"))) {
        existingPackIds.add(entry.name);
      }
    }
  } catch {
    // PACKS_DIR may not exist yet
  }

  const packChoices = PACK_REGISTRY.map((p) => ({
    name: existingPackIds.has(p.id) ? `${p.name} (already installed)` : p.name,
    value: p.id,
    checked: existingPackIds.size > 0
      ? existingPackIds.has(p.id)
      : DEFAULT_DOWNLOAD_PACK_IDS.includes(p.id),
  }));

  const toDownload = await checkbox({
    message: "Which voice packs do you want to install? (downloaded from GitHub)",
    choices: packChoices,
    required: false,
  });

  const baseUrl = getPackRegistryBaseUrl();
  for (const packId of toDownload || []) {
    if (existingPackIds.has(packId)) continue;
    const pack = PACK_REGISTRY.find((p) => p.id === packId);
    const label = pack ? pack.name : packId;
    process.stdout.write(`  Downloading ${label}... `);
    try {
      await downloadPack(packId, baseUrl);
      console.log(color("done.", ANSI.green));
    } catch (err) {
      console.log(`failed (${err.message}).`);
    }
  }

  // --- Step 4: Voice Pack ---
  printStep(4, "Voice Pack");

  const packs = listPacks();
  if (packs.length > 0) {
    const active = config.active_pack || "";
    const packChoices = [
      {
        name: active === "random" ? "Random (current)" : "Random",
        value: "random",
        description: "Picks a different voice each time",
      },
      ...packs.map((p) => ({
        name: p.id === active ? `${p.name} (current)` : p.name,
        value: p.id,
        description: p.id,
      })),
    ];

    const chosenPack = await select({
      message: "Choose a voice pack:",
      choices: packChoices,
      default: active || "sc2-adjutant",
    });
    config.active_pack = chosenPack;
  } else {
    printWarning("No voice packs found. Using default.");
    console.log("");
  }

  // --- Step 5: TTS Server ---
  console.log("");
  printStep(5, "TTS Server");

  const chatterboxUrl = config.chatterbox_url || "http://localhost:8004";
  const qwenUrl = config.qwen_tts_url || "http://localhost:8100";

  process.stdout.write("  Checking Chatterbox (port 8004)... ");
  const chatterboxUp = await probeUrl(`${chatterboxUrl}/health`);
  console.log(chatterboxUp ? "detected!" : "not running");

  process.stdout.write("  Checking Qwen TTS (port 8100)...   ");
  const qwenUp = await probeUrl(`${qwenUrl}/health`);
  console.log(qwenUp ? "detected!" : "not running");

  if (chatterboxUp && qwenUp) {
    const ttsChoice = await select({
      message: "Both TTS servers detected. Which one to use?",
      choices: [
        {
          name: config.tts_backend === "chatterbox" ? "Chatterbox (current, port 8004)" : "Chatterbox (port 8004)",
          value: "chatterbox",
        },
        {
          name: config.tts_backend === "qwen" ? "Qwen TTS (current, port 8100)" : "Qwen TTS (port 8100)",
          value: "qwen",
        },
      ],
      default: config.tts_backend || "chatterbox",
    });
    config.tts_backend = ttsChoice;
  } else if (qwenUp && !chatterboxUp) {
    config.tts_backend = "qwen";
    printSuccess("Using Qwen TTS.");
  } else if (chatterboxUp) {
    config.tts_backend = "chatterbox";
    printSuccess("Using Chatterbox.");
  } else {
    console.log("");
    printWarning("No TTS server detected. VoiceForge will still work with fallback phrases.");
    printStatus("Chatterbox", "https://github.com/resemble-ai/chatterbox");
    printStatus("Qwen TTS", "qwen3-tts-server/ directory");
    console.log("");
  }

  // --- Step 6: Hooks (platforms) ---
  console.log("");
  printStep(6, "Hooks");

  const platformChoices = [
    {
      name: "Claude Code",
      value: "claude",
      description: "Register in ~/.claude/settings.json + install skill",
      checked: hasVoiceForgeHooks() || hasInstalledSkill(),
    },
    {
      name: "Cursor",
      value: "cursor",
      description: "Register in ~/.cursor/hooks.json (Agent / Cmd+K)",
      checked: hasCursorHooks(),
    },
    {
      name: "Codex",
      value: "codex",
      description: "Install/update notify in ~/.codex/config.toml",
      checked: hasCodexNotify(),
    },
  ];

  const selectedPlatforms = await checkbox({
    message: "Which platforms do you want to install hooks for?",
    choices: platformChoices,
    required: false,
  });

  // Determine the hook command for Claude Code (used when "claude" is selected)
  const hookCommand = IS_NPM_GLOBAL ? "voiceforge hook" : join(SCRIPT_DIR, "voiceforge.sh");
  const codexNotifyCommand = IS_NPM_GLOBAL
    ? ["voiceforge", "codex-notify"]
    : [process.execPath, join(SCRIPT_DIR, "src", "cli.js"), "codex-notify"];

  if (selectedPlatforms.includes("claude")) {
    const hookCount = registerHooks(hookCommand);
    printSuccess(`Registered ${hookCount} hook events in ~/.claude/settings.json`);
    if (installSkill()) {
      printSuccess("Installed voiceforge-config skill");
    }
  } else {
    const removed = unregisterHooks();
    const skillRemoved = removeSkill();
    if (removed > 0) {
      printWarning(`Removed ${removed} hook(s) from ~/.claude/settings.json`);
    }
    if (skillRemoved) {
      printWarning("Removed voiceforge-config skill");
    }
  }

  if (selectedPlatforms.includes("cursor")) {
    const cursorCount = registerCursorHooks("voiceforge cursor-hook");
    printSuccess(`Registered ${cursorCount} hook events in ~/.cursor/hooks.json`);
    printStatus("Next", "Restart Cursor to hear VoiceForge in Agent Chat.");
  } else {
    const cursorRemoved = unregisterCursorHooks();
    if (cursorRemoved > 0) {
      printWarning(`Removed ${cursorRemoved} hook(s) from ~/.cursor/hooks.json`);
    }
  }

  if (selectedPlatforms.includes("codex")) {
    registerCodexNotify(codexNotifyCommand);
    printSuccess(`Installed Codex notify command in ${getCodexConfigPath()}`);
  } else {
    const codexRemoved = unregisterCodexNotify();
    if (codexRemoved) {
      printWarning(`Removed Codex notify from ${getCodexConfigPath()}`);
    }
  }

  if (selectedPlatforms.length === 0) {
    printWarning("No platforms selected. Run 'voiceforge setup' again to install hooks later.");
  }

  // --- Save config ---
  saveConfig(config);

  // --- Summary ---
  console.log("");
  console.log(color("=== Setup Complete ===", ANSI.bold));
  console.log("");
  printStatus("Config", CONFIG_PATH);
  if (chosenProvider !== "skip") {
    const p = getProvider(config.llm_backend);
    printStatus("LLM", `${p ? p.name : config.llm_backend} (${config.llm_model || p?.defaultModel || "default"})`);
  } else {
    printStatus("LLM", "Skipped (fallback phrases only)");
  }
  printStatus("Voice", config.active_pack);
  printStatus("TTS", config.tts_backend);
  console.log("");
  console.log(`  ${color("Start a new session in each platform you installed to hear VoiceForge.", ANSI.cyan)}`);
  if (selectedPlatforms.includes("claude")) {
    printStatus("Claude Code", "Start a new Claude Code session.");
  }
  if (selectedPlatforms.includes("cursor")) {
    printStatus("Cursor", "Restart Cursor to hear VoiceForge in Agent Chat.");
  }
  if (selectedPlatforms.includes("codex")) {
    printStatus("Codex", "Start a new Codex session to pick up the notify config.");
  }
  printStatus("Reconfigure", "voiceforge setup");
  console.log("");
}
