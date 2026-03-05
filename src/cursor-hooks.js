import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CURSOR_DIR = join(homedir(), ".cursor");
const HOOKS_FILE = join(CURSOR_DIR, "hooks.json");

const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "stop",
  "postToolUseFailure",
  "preCompact",
];

const HOOK_ENTRY = (command) => ({
  command,
  timeout: 10,
});

function isVoiceForgeHook(entry) {
  const cmd = (entry && entry.command) || "";
  return typeof cmd === "string" && (cmd.includes("voiceforge") || cmd.includes("cursor-hook"));
}

function loadHooks() {
  try {
    return JSON.parse(readFileSync(HOOKS_FILE, "utf-8"));
  } catch {
    return { version: 1, hooks: {} };
  }
}

/**
 * Register VoiceForge in ~/.cursor/hooks.json.
 * Merges with existing hooks; does not remove other hooks.
 * @param {string} command — e.g. "voiceforge cursor-hook"
 * @returns {number} number of hook events registered
 */
export function registerCursorHooks(command) {
  mkdirSync(CURSOR_DIR, { recursive: true });
  const config = loadHooks();
  if (config.version === undefined) config.version = 1;
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};

  let count = 0;
  for (const event of CURSOR_HOOK_EVENTS) {
    const existing = config.hooks[event];
    const arr = Array.isArray(existing) ? existing : [];
    const withoutUs = arr.filter((entry) => !isVoiceForgeHook(entry));
    const entry = HOOK_ENTRY(command);
    config.hooks[event] = [...withoutUs, entry];
    count++;
  }

  writeFileSync(HOOKS_FILE, JSON.stringify(config, null, 2) + "\n");
  return count;
}

/**
 * Remove VoiceForge hook entries from ~/.cursor/hooks.json.
 * Leaves other hooks and the file intact.
 * @returns {number} number of hook entries removed
 */
export function unregisterCursorHooks() {
  try {
    const config = loadHooks();
    if (!config.hooks || typeof config.hooks !== "object") return 0;

    let removed = 0;
    for (const event of Object.keys(config.hooks)) {
      const arr = config.hooks[event];
      if (!Array.isArray(arr)) continue;
      const before = arr.length;
      config.hooks[event] = arr.filter((entry) => !isVoiceForgeHook(entry));
      removed += before - config.hooks[event].length;
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }

    writeFileSync(HOOKS_FILE, JSON.stringify(config, null, 2) + "\n");
    return removed;
  } catch {
    return 0;
  }
}
