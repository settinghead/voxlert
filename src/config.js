import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { CONFIG_PATH, GLOBAL_USER_CONFIG_PATH, SCRIPT_DIR } from "./paths.js";

// Hook event name -> internal category
export const EVENT_MAP = {
  Stop: "task.complete",
  SessionStart: "session.start",
  SessionEnd: "session.end",
  UserPromptSubmit: "task.acknowledge",
  PermissionRequest: "input.required",
  PreCompact: "resource.limit",
  PostToolUseFailure: "task.error",
  Notification: "notification",
};

// Events where we call the LLM for a contextual phrase
export const CONTEXTUAL_EVENTS = new Set(["Stop", "PostToolUseFailure"]);

// Fallback phrases when LLM is unavailable or for non-contextual events
export const FALLBACK_PHRASES = {
  "session.start": [
    "Systems online.",
    "Awaiting orders",
    "Station operational.",
    "All systems nominal.",
    "Ready for deployment.",
  ],
  "task.complete": [
    "Mission complete.",
    "Objective secured",
    "All tasks fulfilled.",
    "Operation completed.",
    "Orders carried out.",
    "Target achieved.",
  ],
  "task.acknowledge": [
    "Orders received.",
    "Request acknowledged",
    "Operations initiated.",
    "Command confirmed.",
    "Directive understood.",
  ],
  "input.required": [
    "Authorization required.",
    "Input needed.",
    "Clearance requested.",
    "Decision awaited.",
    "Confirmation required.",
  ],
  "resource.limit": [
    "Memory capacity critical.",
    "Resources nearly exhausted.",
    "Buffer limit approached.",
    "Context capacity strained.",
    "Power reserves depleted.",
  ],
  "session.end": [
    "Session terminated.",
    "Connection closed.",
    "Signing off.",
    "Session ended.",
    "Disconnected.",
  ],
  "task.error": [
    "Operation failed.",
    "Error detected.",
    "Task aborted.",
    "Execution error.",
    "Failure reported.",
  ],
  notification: [
    "Alert received.",
    "Status change detected.",
    "Notification logged.",
  ],
};

// Fields allowed in per-directory and global-user config overrides
const PROJECT_OVERRIDE_FIELDS = new Set([
  "enabled",
  "active_pack",
  "volume",
  "categories",
  "collect_llm_data",
  "max_cache_entries",
  "prefix",
  "tts_backend",
  "qwen_tts_url",
  "overlay",
  "overlay_dismiss",
]);

/**
 * Walk up from cwd toward home directory looking for project config.
 * Checks each directory for .voiceforge.json then .voiceforge/config.json.
 * Returns the parsed config object from the nearest match, or null.
 */
function findProjectConfig(cwd) {
  if (!cwd) return null;

  const home = homedir();
  let dir = cwd;

  while (true) {
    // Don't check $HOME itself — that's the global user tier
    if (dir === home) break;

    // Check .voiceforge.json first (wins over .voiceforge/config.json)
    const dotFile = join(dir, ".voiceforge.json");
    try {
      if (existsSync(dotFile)) {
        return JSON.parse(readFileSync(dotFile, "utf-8"));
      }
    } catch {
      // Malformed JSON — skip and keep walking
    }

    // Check .voiceforge/config.json
    const dirFile = join(dir, ".voiceforge", "config.json");
    try {
      if (existsSync(dirFile)) {
        return JSON.parse(readFileSync(dirFile, "utf-8"));
      }
    } catch {
      // Malformed JSON — skip and keep walking
    }

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return null;
}

/**
 * Load the global user config from ~/.voiceforge/config.json.
 * Returns empty object if missing or malformed.
 */
function loadGlobalUserConfig() {
  try {
    return JSON.parse(readFileSync(GLOBAL_USER_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Strip disallowed fields from an override config object.
 */
function filterOverrideFields(config) {
  const filtered = {};
  for (const key of Object.keys(config)) {
    if (PROJECT_OVERRIDE_FIELDS.has(key)) {
      filtered[key] = config[key];
    }
  }
  return filtered;
}

/**
 * Merge configs with shallow merge for most fields, deep merge for categories.
 */
function mergeConfigs(base, ...overrides) {
  const result = { ...base };
  for (const override of overrides) {
    if (!override || typeof override !== "object") continue;
    for (const [key, value] of Object.entries(override)) {
      if (key === "categories" && typeof value === "object" && value !== null) {
        result.categories = { ...(result.categories || {}), ...value };
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Load config with 3-tier resolution:
 *   1. Install-dir config.json (base)
 *   2. ~/.voiceforge/config.json (global user prefs, whitelist-filtered)
 *   3. Nearest .voiceforge.json / .voiceforge/config.json (project override, whitelist-filtered)
 *
 * When called without cwd, behaves like the original (install config + global user only).
 */
export function loadConfig(cwd) {
  // Tier 1: install-dir base config
  let base;
  try {
    base = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    base = { enabled: true };
  }

  // Tier 2: global user config
  const globalUser = filterOverrideFields(loadGlobalUserConfig());

  // Tier 3: project config (nearest-only)
  const project = cwd ? filterOverrideFields(findProjectConfig(cwd) || {}) : {};

  return mergeConfigs(base, globalUser, project);
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Ensure config.json exists — creates from config.default.json template if missing.
 * Returns the loaded config.
 */
export function ensureConfig() {
  if (!existsSync(CONFIG_PATH)) {
    const templatePath = join(SCRIPT_DIR, "config.default.json");
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    if (existsSync(templatePath)) {
      copyFileSync(templatePath, CONFIG_PATH);
    } else {
      writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: true }, null, 2) + "\n");
    }
  }
  return loadConfig();
}
