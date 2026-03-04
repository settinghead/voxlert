/**
 * VoiceForge — On-screen overlay notification wrapper.
 *
 * Spawns a native macOS Cocoa overlay via JXA (osascript -l JavaScript).
 * No-op on non-darwin platforms or when overlay is disabled in config.
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync, rmdirSync, readdirSync, statSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(__dirname);
const JXA_SCRIPT = join(__dirname, "overlay.jxa");
const SLOT_DIR = "/tmp/voiceforge-popups";
const MAX_SLOTS = 5;
const STALE_MS = 60_000;

// Default gradient (dark charcoal)
const DEFAULT_COLORS = [[0.15, 0.15, 0.2], [0.1, 0.1, 0.15]];

/**
 * Acquire a slot for vertical stacking. Uses mkdir for race-safe locking.
 * Returns slot index (0-based) or -1 if all slots taken.
 */
function acquireSlot() {
  mkdirSync(SLOT_DIR, { recursive: true });

  // Clean stale slots first
  try {
    const entries = readdirSync(SLOT_DIR);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.startsWith("slot-")) continue;
      try {
        const st = statSync(join(SLOT_DIR, entry));
        if (now - st.mtimeMs > STALE_MS) {
          rmdirSync(join(SLOT_DIR, entry));
        }
      } catch {
        // already removed
      }
    }
  } catch {
    // best-effort cleanup
  }

  // Try to acquire a slot
  for (let i = 0; i < MAX_SLOTS; i++) {
    const slotPath = join(SLOT_DIR, `slot-${i}`);
    try {
      mkdirSync(slotPath);
      return i;
    } catch {
      // slot taken, try next
    }
  }
  return -1;
}

/**
 * Release a slot after dismiss + buffer time.
 */
function releaseSlotAfter(slot, delaySecs) {
  const slotPath = join(SLOT_DIR, `slot-${slot}`);
  setTimeout(() => {
    try {
      rmdirSync(slotPath);
    } catch {
      // already removed
    }
  }, delaySecs * 1000);
}

/**
 * Resolve icon path for a pack. Looks for assets/{packId}.{png,jpg,gif}.
 */
function resolveIcon(packId) {
  if (!packId) return "";
  const exts = ["png", "jpg", "gif"];
  for (const ext of exts) {
    const p = join(SCRIPT_DIR, "assets", `${packId}.${ext}`);
    if (existsSync(p)) return p;
  }
  return "";
}

/**
 * Show an overlay notification.
 *
 * Fire-and-forget — spawns osascript detached and returns immediately.
 *
 * @param {string} phrase - The phrase to display
 * @param {object} opts
 * @param {string} opts.category - Event category
 * @param {string} opts.packName - Display name of the voice pack
 * @param {string} opts.packId - Pack identifier (for icon lookup)
 * @param {string} opts.prefix - Resolved prefix string
 * @param {object} opts.config - Loaded config object
 * @param {Array} [opts.overlayColors] - Gradient colors from pack
 */
export function showOverlay(phrase, { category, packName, packId, prefix, config, overlayColors } = {}) {
  // No-op on non-macOS
  if (process.platform !== "darwin") return;

  // No-op if overlay disabled
  if (config && config.overlay === false) return;

  // No-op if JXA script missing
  if (!existsSync(JXA_SCRIPT)) return;

  const dismissSecs = (config && config.overlay_dismiss) || 4;
  const colors = overlayColors || DEFAULT_COLORS;
  const iconPath = resolveIcon(packId);

  // Build subtitle: "prefix · PACK_NAME"
  let subtitle = "";
  const parts = [];
  if (prefix) parts.push(prefix);
  if (packName) parts.push(packName.toUpperCase());
  subtitle = parts.join("  ·  ");

  // Strip prefix from phrase for display (it's shown in subtitle)
  let displayPhrase = phrase;
  if (prefix && phrase.startsWith(prefix + "; ")) {
    displayPhrase = phrase.slice(prefix.length + 2);
  }

  // Acquire stacking slot
  const slot = acquireSlot();
  if (slot < 0) return; // all slots full

  // Spawn osascript detached
  const args = [
    "-l", "JavaScript",
    JXA_SCRIPT,
    displayPhrase,
    JSON.stringify(colors),
    iconPath,
    String(slot),
    String(dismissSecs),
    subtitle,
  ];

  try {
    const child = spawn("osascript", args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // best-effort — don't break audio pipeline
  }

  // Schedule slot release after dismiss + 2s buffer
  releaseSlotAfter(slot, dismissSecs + 2);
}
