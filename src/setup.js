/**
 * Interactive setup wizard for VoiceForge.
 * Handles LLM provider selection, API key input, voice pack picking,
 * TTS server detection, and Claude Code hook registration.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "fs";
import { join } from "path";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import select from "@inquirer/select";
import input from "@inquirer/input";
import confirm from "@inquirer/confirm";
import { loadConfig, saveConfig, ensureConfig } from "./config.js";
import { listPacks } from "./packs.js";
import { CONFIG_PATH, PACKS_DIR, CACHE_DIR, IS_NPM_GLOBAL, BUNDLED_PACKS_DIR, SCRIPT_DIR } from "./paths.js";
import { LLM_PROVIDERS, getProvider } from "./providers.js";
import { registerHooks, installSkill } from "./hooks.js";
import { registerCursorHooks } from "./cursor-hooks.js";

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

export async function runSetup({ fromInstallSh = false } = {}) {
  console.log("\n=== VoiceForge Setup ===\n");

  // Ensure config exists
  ensureConfig();
  ensurePacks();
  mkdirSync(CACHE_DIR, { recursive: true });

  const config = loadConfig();

  // --- Step 1: LLM Provider ---
  console.log("Step 1/5: LLM Provider\n");

  const providerChoices = [
    ...Object.entries(LLM_PROVIDERS).map(([id, p]) => ({
      name: id === "openrouter" ? `${p.name} (recommended) — ${p.description}` : `${p.name} — ${p.description}`,
      value: id,
    })),
    { name: "Skip — fallback phrases only, no API key needed", value: "skip" },
  ];

  const currentBackend = config.llm_backend || "openrouter";
  const chosenProvider = await select({
    message: "Which LLM provider would you like to use?",
    choices: providerChoices,
    default: currentBackend !== "local" ? currentBackend : "openrouter",
  });

  let apiKey = "";

  if (chosenProvider !== "skip") {
    config.llm_backend = chosenProvider;
    const provider = getProvider(chosenProvider);

    // --- Step 2: API Key ---
    console.log(`\nStep 2/5: API Key\n`);
    console.log(`  Get a key at: ${provider.signupUrl}\n`);

    const existingKey = config.llm_api_key || config.openrouter_api_key || "";
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
        console.log("valid!\n");
      } else {
        console.log(`could not validate (${result.error || "unknown error"})`);
        const proceed = await confirm({
          message: "Use this key anyway?",
          default: true,
        });
        if (!proceed) {
          apiKey = "";
          console.log("  Skipped — you can set it later with: voiceforge config set llm_api_key <key>\n");
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
      }
    }

    // Set default model for chosen provider
    if (!config.llm_model && !config.openrouter_model) {
      config.llm_model = provider.defaultModel;
    }
  } else {
    console.log("\n  Skipped — VoiceForge will use fallback phrases from the voice pack.\n");
  }

  // --- Step 3: Voice Pack ---
  console.log("Step 3/5: Voice Pack\n");

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
    console.log("  No voice packs found. Using default.\n");
  }

  // --- Step 4: TTS Server ---
  console.log("\nStep 4/5: TTS Server\n");

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
        { name: "Chatterbox (port 8004)", value: "chatterbox" },
        { name: "Qwen TTS (port 8100)", value: "qwen" },
      ],
      default: config.tts_backend || "chatterbox",
    });
    config.tts_backend = ttsChoice;
  } else if (qwenUp && !chatterboxUp) {
    config.tts_backend = "qwen";
    console.log("  Using Qwen TTS.");
  } else if (chatterboxUp) {
    config.tts_backend = "chatterbox";
    console.log("  Using Chatterbox.");
  } else {
    console.log("\n  No TTS server detected. VoiceForge will still work with fallback phrases.");
    console.log("  To set up Chatterbox TTS later, see: https://github.com/resemble-ai/chatterbox");
    console.log("  To set up Qwen TTS, see the qwen3-tts-experiment/ directory.\n");
  }

  // --- Step 5: Claude Code Hooks ---
  console.log("\nStep 5/5: Claude Code Hooks\n");

  // Determine the hook command based on install mode
  let hookCommand;
  if (fromInstallSh) {
    // install.sh: use absolute path to voiceforge.sh in the install dir
    const installDir = join(process.env.HOME || "", ".claude", "hooks", "voiceforge");
    hookCommand = join(installDir, "voiceforge.sh");
  } else if (IS_NPM_GLOBAL) {
    // npm global: use the CLI itself as the hook command
    hookCommand = "voiceforge hook";
  } else {
    // Local dev / git clone
    hookCommand = join(SCRIPT_DIR, "voiceforge.sh");
  }

  const hookCount = registerHooks(hookCommand);
  console.log(`  Registered ${hookCount} hook events in ~/.claude/settings.json`);

  const skillInstalled = installSkill();
  if (skillInstalled) {
    console.log("  Installed voiceforge-config skill");
  }

  const installCursor = await confirm({
    message: "Install Cursor hooks? (voice notifications in Cursor Agent / Cmd+K)",
    default: false,
  });
  if (installCursor) {
    const cursorCommand = "voiceforge cursor-hook";
    const cursorCount = registerCursorHooks(cursorCommand);
    console.log(`  Registered ${cursorCount} hook events in ~/.cursor/hooks.json`);
    console.log("  Restart Cursor for hooks to take effect.");
  }

  // --- Save config ---
  saveConfig(config);

  // --- Summary ---
  console.log("\n=== Setup Complete ===\n");
  console.log(`  Config: ${CONFIG_PATH}`);
  if (chosenProvider !== "skip") {
    const p = getProvider(config.llm_backend);
    console.log(`  LLM:    ${p ? p.name : config.llm_backend} (${config.llm_model || p?.defaultModel || "default"})`);
  } else {
    console.log("  LLM:    Skipped (fallback phrases only)");
  }
  console.log(`  Voice:  ${config.active_pack}`);
  console.log(`  TTS:    ${config.tts_backend}`);
  console.log("\n  Start a new Claude Code session to hear VoiceForge!");
  if (installCursor) {
    console.log("  Restart Cursor to hear VoiceForge in Agent Chat.");
  }
  console.log("  To reconfigure: voiceforge setup\n");
}
