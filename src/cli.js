#!/usr/bin/env node

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import select from "@inquirer/select";
import { loadConfig, saveConfig, FALLBACK_PHRASES } from "./config.js";
import { generatePhrase } from "./llm.js";
import { speakPhrase } from "./audio.js";
import { loadPack, listPacks } from "./packs.js";
import { formatCost, resetUsage } from "./cost.js";
import { CONFIG_PATH } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const HELP = `
voiceforge v${pkg.version} — Game character voice notifications for Claude Code

Usage:
  voiceforge config              Show current configuration
  voiceforge config show         Show current configuration
  voiceforge config set <k> <v>  Set a config value (supports categories.X dot notation)
  voiceforge config path         Print config file path
  voiceforge voice               Interactive voice pack picker
  voiceforge pack list           List available voice packs
  voiceforge pack show           Show active pack details
  voiceforge pack use <pack-id>  Switch active voice pack
  voiceforge volume              Show current volume and prompt for new value
  voiceforge volume <0-100>      Set playback volume (0 = mute, 100 = max)
  voiceforge test "<text>"       Run full pipeline: LLM -> TTS -> audio playback
  voiceforge cost                Show accumulated token usage and estimated cost
  voiceforge cost reset          Clear the usage log
  voiceforge help                Show this help message
  voiceforge --version           Show version
`.trim();

function maskKey(key) {
  if (!key || typeof key !== "string") return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

function showConfig() {
  const config = loadConfig(process.cwd());
  const display = { ...config };
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

// --- Main ---
(async () => {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const sub = args[1] || "";

  switch (cmd) {
    case "config":
      if (sub === "set") {
        configSet(args[2], args.slice(3).join(" "));
      } else if (sub === "path") {
        console.log(CONFIG_PATH);
      } else {
        showConfig();
      }
      break;

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
