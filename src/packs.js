import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { PACKS_DIR } from "./paths.js";

// Target mean volume in dBFS — voices are normalized to this level
const TARGET_MEAN_DB = -16;

/**
 * Analyze a WAV file's mean volume using ffmpeg volumedetect.
 * Returns mean_volume in dBFS, or null on failure.
 */
function analyzeVolume(wavPath) {
  try {
    const output = execSync(
      `ffmpeg -i "${wavPath}" -af volumedetect -f null /dev/null 2>&1`,
      { encoding: "utf-8", timeout: 10000 },
    );
    const match = output.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (match) return parseFloat(match[1]);
  } catch {
    // ffmpeg not available or analysis failed
  }
  return null;
}

/**
 * Get volume offset in dB for a pack's voice file.
 * Caches result in .volume file next to voice.wav.
 */
function getVolumeOffsetDb(voicePath, packDir) {
  if (!voicePath || !existsSync(voicePath)) return 0;

  // Check cache
  const cachePath = join(packDir, ".volume");
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (cached.voicePath === voicePath && typeof cached.offsetDb === "number") {
      return cached.offsetDb;
    }
  } catch {
    // no cache or invalid
  }

  // Analyze and cache
  const meanDb = analyzeVolume(voicePath);
  if (meanDb == null) return 0;

  const offsetDb = Math.round((TARGET_MEAN_DB - meanDb) * 10) / 10;
  try {
    writeFileSync(cachePath, JSON.stringify({ voicePath, meanDb, offsetDb }) + "\n");
  } catch {
    // best-effort caching
  }
  return offsetDb;
}

/**
 * Load a voice pack by id (from config.active_pack).
 * Returns { id, name, echo, voicePath, system_prompt, fallback_phrases }.
 * Falls back to legacy config.voice if no active_pack is set.
 */
export function loadPack(config) {
  const packId = config.active_pack;

  // Legacy fallback: no active_pack configured
  if (!packId) {
    return {
      id: "_legacy",
      name: "Legacy",
      echo: true,
      voicePath: config.voice || "default.wav",
      volumeOffsetDb: 0,
      system_prompt: null,
      fallback_phrases: null,
    };
  }

  const packDir = join(PACKS_DIR, packId);
  const packJsonPath = join(packDir, "pack.json");

  let packData;
  try {
    packData = JSON.parse(readFileSync(packJsonPath, "utf-8"));
  } catch {
    // Pack not found or invalid — fall back to defaults
    return {
      id: packId,
      name: packId,
      echo: true,
      voicePath: config.voice || "default.wav",
      volumeOffsetDb: 0,
      system_prompt: null,
      fallback_phrases: null,
    };
  }

  // Resolve voice path: relative to pack dir, or fall back to config.voice
  let voicePath = config.voice || "default.wav";
  if (packData.voice) {
    const resolved = resolve(packDir, packData.voice);
    if (existsSync(resolved)) {
      voicePath = resolved;
    }
  }

  return {
    id: packId,
    name: packData.name || packId,
    echo: packData.echo !== false,
    voicePath,
    volumeOffsetDb: getVolumeOffsetDb(voicePath, packDir),
    system_prompt: packData.system_prompt || null,
    fallback_phrases: packData.fallback_phrases || null,
  };
}

/**
 * List all available voice packs.
 * Returns [{ id, name }].
 */
export function listPacks() {
  const packs = [];
  let entries;
  try {
    entries = readdirSync(PACKS_DIR, { withFileTypes: true });
  } catch {
    return packs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packJsonPath = join(PACKS_DIR, entry.name, "pack.json");
    try {
      const data = JSON.parse(readFileSync(packJsonPath, "utf-8"));
      packs.push({ id: entry.name, name: data.name || entry.name });
    } catch {
      // skip invalid packs
    }
  }
  return packs;
}
