import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_DIR = dirname(__dirname);

// Detect npm global install (src/ lives inside node_modules)
export const IS_NPM_GLOBAL = SCRIPT_DIR.includes("node_modules");

// User-level config and state in ~/.voiceforge
export const STATE_DIR = join(homedir(), ".voiceforge");

// When npm global: mutable data goes to ~/.voiceforge/
// When git clone: unchanged behavior (install dir)
export const CONFIG_PATH = IS_NPM_GLOBAL
  ? join(STATE_DIR, "config.json")
  : join(SCRIPT_DIR, "config.json");
export const PACKS_DIR = IS_NPM_GLOBAL
  ? join(STATE_DIR, "packs")
  : join(SCRIPT_DIR, "packs");
export const CACHE_DIR = IS_NPM_GLOBAL
  ? join(STATE_DIR, "cache")
  : join(SCRIPT_DIR, "cache");
export const COLLECT_DIR = IS_NPM_GLOBAL
  ? join(STATE_DIR, "llm_collect")
  : join(SCRIPT_DIR, "llm_collect");

// Packs shipped with the npm package (read-only)
export const BUNDLED_PACKS_DIR = join(SCRIPT_DIR, "packs");

export const GLOBAL_USER_CONFIG_PATH = join(STATE_DIR, "config.json");
export const QUEUE_DIR = join(STATE_DIR, "queue");
export const LOCK_FILE = join(STATE_DIR, "playback.lock");
export const LOG_FILE = join(STATE_DIR, "fallback.log");
export const MAIN_LOG_FILE = join(STATE_DIR, "voiceforge.log");
export const HOOK_DEBUG_LOG = join(STATE_DIR, "hook-debug.log");
export const USAGE_FILE = join(STATE_DIR, "usage.jsonl");
