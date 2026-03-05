#!/usr/bin/env node
/**
 * VoiceForge - Game character voice notifications for Claude Code.
 *
 * Generates contextual 2-8 word phrases via OpenRouter LLM,
 * speaks them through a local Chatterbox TTS server.
 */

import { basename } from "path";
import { appendFileSync, mkdirSync } from "fs";
import { loadConfig, EVENT_MAP, CONTEXTUAL_EVENTS, FALLBACK_PHRASES } from "./config.js";
import { extractContext, generatePhrase } from "./llm.js";
import { speakPhrase } from "./audio.js";
import { showOverlay } from "./overlay.js";
import { loadPack } from "./packs.js";
import { STATE_DIR, LOG_FILE, HOOK_DEBUG_LOG } from "./paths.js";
import { appendLog } from "./activity-log.js";

function debugLog(msg, data) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const line = data !== undefined
      ? `[${new Date().toISOString()}] ${msg} ${JSON.stringify(data)}\n`
      : `[${new Date().toISOString()}] ${msg}\n`;
    appendFileSync(HOOK_DEBUG_LOG, line);
  } catch {
    // best-effort
  }
}

function logFallback(eventName, reason, detail) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const line = detail
      ? `[${ts}] event=${eventName} reason=${reason} detail=${typeof detail === "string" ? detail : JSON.stringify(detail)}\n`
      : `[${ts}] event=${eventName} reason=${reason}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort logging
  }
}

/**
 * Process a hook event from parsed JSON input.
 * Exported so it can be called from the CLI `voiceforge hook` command.
 */
export async function processHookEvent(eventData) {
  const source = eventData.source || "claude";
  debugLog("processHookEvent entered", { source, hook_event_name: eventData.hook_event_name, cwd: eventData.cwd });
  const cwd = eventData.cwd || "";
  const config = loadConfig(cwd || undefined);
  if (config.enabled === false) {
    debugLog("processHookEvent skip: config.enabled === false", { source });
    return;
  }

  const eventName = eventData.hook_event_name || "";
  const category = EVENT_MAP[eventName];
  if (!category) {
    debugLog("processHookEvent skip: no category for event", { source, eventName });
    return;
  }

  // Check if category is enabled
  const categories = config.categories || {};
  if (categories[category] === false) {
    debugLog("processHookEvent skip: category disabled", { source, category });
    return;
  }

  debugLog("processHookEvent processing", { source, eventName, category });
  // Load active voice pack
  const pack = loadPack(config);
  const projectName = cwd ? basename(cwd) : "";

  // For contextual events, try LLM phrase generation
  let phrase = null;
  let fallbackReason = null;
  let fallbackDetail = null;
  if (CONTEXTUAL_EVENTS.has(eventName)) {
    const context = extractContext(eventData);
    if (context) {
      const result = await generatePhrase(context, config, pack.style, pack.llm_temperature, pack.examples);
      phrase = result.phrase;
      fallbackReason = result.fallbackReason;
      fallbackDetail = result.detail || null;
    } else {
      fallbackReason = "no_context";
    }
  }

  // Fall back to predefined phrases (pack overrides defaults)
  if (!phrase) {
    if (fallbackReason && config.error_log === true) {
      logFallback(eventName, fallbackReason, fallbackDetail);
    }
    const fallbackSource = pack.fallback_phrases || FALLBACK_PHRASES;
    const phrases = fallbackSource[category] || ["Standing by"];
    phrase = phrases[Math.floor(Math.random() * phrases.length)];
  }

  // Prepend prefix (supports ${dirname} template variable)
  const prefixTemplate = config.prefix !== undefined ? config.prefix : "${dirname}";
  let resolvedPrefix = "";
  if (prefixTemplate !== "") {
    resolvedPrefix = prefixTemplate.replace(/\$\{dirname\}/g, projectName);
    if (resolvedPrefix) {
      phrase = `${resolvedPrefix}; ${phrase}`;
    }
  }

  const packId = config.active_pack || "sc2-adjutant";
  const phraseOneLine = phrase.replace(/\s+/g, " ").slice(0, 120);
  debugLog("processHookEvent speaking", { source, phrase: phraseOneLine });
  appendLog(
    `[${new Date().toISOString()}] source=${source} event=${eventName} category=${category} phrase=${phraseOneLine}${phrase.length > 120 ? "…" : ""}`,
    config,
  );
  showOverlay(phrase, {
    category,
    packName: pack.name,
    packId: pack.id || packId,
    prefix: resolvedPrefix,
    config,
    overlayColors: pack.overlay_colors,
  });

  await speakPhrase(phrase, config, pack);
  debugLog("processHookEvent done (speakPhrase returned)", { source });
}

async function main() {
  // Read event data from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let eventData;
  try {
    eventData = JSON.parse(input);
  } catch {
    return;
  }

  await processHookEvent(eventData);
}

// Only run main() when this file is the entry point (not when imported by cli.js)
const entryUrl = new URL(process.argv[1], "file://").href;
const thisUrl = new URL(import.meta.url).href;
if (entryUrl === thisUrl) {
  main();
}
