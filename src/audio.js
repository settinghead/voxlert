import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
  utimesSync,
} from "fs";
import { join, dirname, extname } from "path";
import { createHash } from "crypto";
import { spawn, execSync } from "child_process";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { CACHE_DIR, QUEUE_DIR, LOCK_FILE } from "./paths.js";

const DEFAULT_MAX_CACHE = 150;

function evictCache(cacheDir, maxEntries) {
  let files;
  try {
    files = readdirSync(cacheDir)
      .filter((f) => f.endsWith(".wav"))
      .map((f) => {
        const p = join(cacheDir, f);
        return { path: p, atime: statSync(p).atimeMs };
      });
  } catch {
    return;
  }
  if (files.length <= maxEntries) return;
  // Sort oldest-accessed first, remove excess
  files.sort((a, b) => a.atime - b.atime);
  const toRemove = files.length - maxEntries;
  for (let i = 0; i < toRemove; i++) {
    try {
      unlinkSync(files[i].path);
    } catch {
      // ignore
    }
  }
}

function touchFile(filePath) {
  const now = new Date();
  try {
    utimesSync(filePath, now, statSync(filePath).mtime);
  } catch {
    // ignore
  }
}

function audioFilter() {
  // Short multi-tap echo: two taps at 40ms and 75ms with moderate decay
  return "aecho=0.8:0.88:40|75:0.4|0.25";
}

// --- File-based playback queue ---

function acquireLock() {
  mkdirSync(QUEUE_DIR, { recursive: true });
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — check if holder is still alive
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      process.kill(pid, 0); // throws if dead
      return false; // holder alive, let it drain the queue
    } catch {
      // Stale lock — reclaim
      try {
        unlinkSync(LOCK_FILE);
        writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    }
  }
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function enqueue(cachePath, volume) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(QUEUE_DIR, filename), JSON.stringify({ cachePath, volume }));
}

function getNextEntry() {
  try {
    const files = readdirSync(QUEUE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    return files.length > 0 ? files[0] : null;
  } catch {
    return null;
  }
}

// --- Playback ---

function applyEcho(cachePath, customAudioFilter) {
  if (!existsSync(cachePath)) return;
  const tmpOut = cachePath + ".fx.wav";
  const filter = customAudioFilter || audioFilter();
  try {
    execSync(
      `ffmpeg -y -i "${cachePath}" -af "${filter}" "${tmpOut}"`,
      { timeout: 10000, stdio: "ignore" },
    );
    if (existsSync(tmpOut)) {
      unlinkSync(cachePath);
      renameSync(tmpOut, cachePath);
    }
  } catch {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/**
 * Return { cmd, args } to play a WAV file, or null if no player for this platform.
 * - darwin: afplay (macOS)
 * - win32: ffplay (FFmpeg) — install FFmpeg and add to PATH
 * - linux: ffplay, else paplay (PulseAudio) or pw-play (PipeWire)
 */
function getPlaybackCommand(platform, volume, cachePath) {
  const vol = Math.max(0, Math.min(1, volume));
  if (platform === "darwin") {
    return { cmd: "afplay", args: ["-v", String(vol), cachePath] };
  }
  if (platform === "win32") {
    return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", cachePath] };
  }
  if (platform === "linux") {
    return { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", cachePath] };
  }
  return null;
}

export function playFile(cachePath, volume) {
  return new Promise((resolve) => {
    if (!existsSync(cachePath)) return resolve();
    const platform = process.platform;
    const spec = getPlaybackCommand(platform, volume, cachePath);
    if (!spec) return resolve();
    const proc = spawn(spec.cmd, spec.args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

async function processQueue() {
  if (!acquireLock()) return;
  try {
    let entry;
    while ((entry = getNextEntry())) {
      const entryPath = join(QUEUE_DIR, entry);
      try {
        const entry_data = JSON.parse(
          readFileSync(entryPath, "utf-8"),
        );
        unlinkSync(entryPath);
        await playFile(entry_data.cachePath, entry_data.volume);
      } catch {
        try {
          unlinkSync(entryPath);
        } catch {
          // ignore
        }
      }
    }
  } finally {
    releaseLock();
  }
}

// --- TTS download ---

function downloadChatterbox(phrase, cachePath, config, voicePath, ttsParams) {
  return new Promise((resolve) => {
    const chatterboxUrl = config.chatterbox_url || "http://localhost:8004";
    const endpoint = `${chatterboxUrl}/tts`;

    const body = {
      text: phrase,
      voice_mode: "predefined",
      predefined_voice_id: voicePath || config.voice || "default.wav",
      output_format: "wav",
    };
    // Apply per-pack TTS parameters (exaggeration, cfg_weight, temperature)
    if (ttsParams) {
      if (ttsParams.exaggeration != null) body.exaggeration = ttsParams.exaggeration;
      if (ttsParams.cfg_weight != null) body.cfg_weight = ttsParams.cfg_weight;
      if (ttsParams.temperature != null) body.temperature = ttsParams.temperature;
    }
    const payload = JSON.stringify(body);

    const url = new URL(endpoint);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;

    const req = requestFn(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve();
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            writeFileSync(cachePath, Buffer.concat(chunks));
          } catch {
            // ignore
          }
          resolve();
        });
        res.on("error", () => resolve());
      },
    );

    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

function downloadQwen(phrase, cachePath, config, packId) {
  return new Promise((resolve) => {
    const qwenUrl = config.qwen_tts_url || "http://localhost:8100";
    const endpoint = `${qwenUrl}/tts`;

    const payload = JSON.stringify({ text: phrase, pack_id: packId });

    const url = new URL(endpoint);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;

    const req = requestFn(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve();
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            writeFileSync(cachePath, Buffer.concat(chunks));
          } catch {
            // ignore
          }
          resolve();
        });
        res.on("error", () => resolve());
      },
    );

    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

function downloadToCache(phrase, cachePath, config, voicePath, ttsParams, packId) {
  if (config.tts_backend === "qwen") {
    return downloadQwen(phrase, cachePath, config, packId);
  }
  return downloadChatterbox(phrase, cachePath, config, voicePath, ttsParams);
}

// --- Post-processing ---

function normalizeVolume(cachePath) {
  if (!existsSync(cachePath)) return;
  const tmpOut = cachePath + ".norm.wav";
  try {
    // Simple peak normalization to -3dB headroom — no look-ahead artifacts
    execSync(
      `sox "${cachePath}" "${tmpOut}" norm -3`,
      { timeout: 10000, stdio: "ignore" },
    );
    if (existsSync(tmpOut)) {
      unlinkSync(cachePath);
      renameSync(tmpOut, cachePath);
    }
  } catch {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

function postProcess(cachePath, command) {
  if (!command || !existsSync(cachePath)) return;
  const tmpOut = cachePath + ".tmp.wav";
  // Support both $INPUT and ${INPUT} placeholder styles.
  const cmd = command
    .replace(/\$\{INPUT\}/g, cachePath)
    .replace(/\$INPUT/g, cachePath)
    .replace(/\$\{OUTPUT\}/g, tmpOut)
    .replace(/\$OUTPUT/g, tmpOut);
  try {
    execSync(cmd, { timeout: 15000, stdio: "ignore" });
    if (existsSync(tmpOut)) {
      unlinkSync(cachePath);
      renameSync(tmpOut, cachePath);
    }
  } catch {
    // Post-processing failed — use raw TTS output
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

function convertAudioFile(inputPath, outputPath) {
  const ext = extname(outputPath).toLowerCase();
  try {
    if (ext === ".mp3") {
      execSync(
        `ffmpeg -y -i "${inputPath}" -ar 44100 -ac 1 -c:a libmp3lame -b:a 96k "${outputPath}"`,
        { timeout: 15000, stdio: "ignore" },
      );
      return true;
    }

    execSync(
      `ffmpeg -y -i "${inputPath}" -ar 44100 -ac 1 -c:a pcm_s16le "${outputPath}"`,
      { timeout: 15000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export async function renderPhraseToFile(phrase, outputPath, config, pack) {
  const outDir = dirname(outputPath);
  mkdirSync(outDir, { recursive: true });

  const tempBase = join(outDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const rawPath = `${tempBase}.raw.wav`;
  const workingPath = `${tempBase}.wav`;
  const packId = (pack && pack.id) || "_default";
  const voicePath = (pack && pack.voicePath) || config.voice || "default.wav";
  const ttsParams = pack ? pack.tts_params : null;
  const customAudioFilter = (pack && pack.audio_filter) || null;
  const postProcessCmd = (pack && pack.post_process) || null;
  const echo = pack ? pack.echo !== false : true;

  try {
    await downloadToCache(phrase, rawPath, config, voicePath, ttsParams, packId);
    if (!existsSync(rawPath)) return false;

    renameSync(rawPath, workingPath);

    if (postProcessCmd) postProcess(workingPath, postProcessCmd);
    if (customAudioFilter || echo) applyEcho(workingPath, customAudioFilter);
    normalizeVolume(workingPath);

    return convertAudioFile(workingPath, outputPath);
  } finally {
    for (const path of [rawPath, workingPath]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }
}

// --- Public API ---

export async function speakPhrase(phrase, config, pack) {
  const packId = (pack && pack.id) || "_default";
  const packCacheDir = join(CACHE_DIR, packId);
  mkdirSync(packCacheDir, { recursive: true });

  const ttsParams = pack ? pack.tts_params : null;
  const backend = config.tts_backend || "chatterbox";
  const cacheKey = createHash("md5")
    .update(backend + ":" + phrase.toLowerCase() + (ttsParams ? JSON.stringify(ttsParams) : ""))
    .digest("hex");
  const cachePath = join(packCacheDir, `${cacheKey}.wav`);
  const volume = config.volume ?? 0.5;
  const maxCache = config.max_cache_entries ?? DEFAULT_MAX_CACHE;
  const echo = pack ? pack.echo !== false : true;
  const voicePath = (pack && pack.voicePath) || config.voice || "default.wav";
  const customAudioFilter = (pack && pack.audio_filter) || null;
  const postProcessCmd = (pack && pack.post_process) || null;

  // Ensure audio is in cache (all effects baked in at cache time)
  if (existsSync(cachePath)) {
    touchFile(cachePath);
  } else {
    await downloadToCache(phrase, cachePath, config, voicePath, ttsParams, packId);
    if (!existsSync(cachePath)) return; // download failed
    if (postProcessCmd) postProcess(cachePath, postProcessCmd);
    if (customAudioFilter || echo) applyEcho(cachePath, customAudioFilter);
    normalizeVolume(cachePath);
    evictCache(packCacheDir, maxCache);
  }

  // Enqueue and try to become the player
  enqueue(cachePath, volume);
  await processQueue();
}
