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

// voice_id cache: voicePath -> voice_id (avoids re-uploading every call)
const _voiceIdCache = new Map();

function _buildMultipart(fields, files) {
  const boundary = `----VoxlertBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const { name, filename, contentType, data } of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    ));
    parts.push(data);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function registerVoiceWithQwen(config, voicePath, refText) {
  if (_voiceIdCache.has(voicePath)) {
    return Promise.resolve(_voiceIdCache.get(voicePath));
  }
  if (!voicePath || !existsSync(voicePath) || !refText) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const qwenUrl = config.qwen_tts_url || "http://localhost:8100";
    const endpoint = `${qwenUrl}/voices`;

    let audioData;
    try {
      audioData = readFileSync(voicePath);
    } catch {
      return resolve(null);
    }

    const { boundary, body } = _buildMultipart(
      { ref_text: refText },
      [{ name: "audio", filename: "voice.wav", contentType: "audio/wav", data: audioData }],
    );

    const url = new URL(endpoint);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;

    const req = requestFn(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (result.voice_id) {
              _voiceIdCache.set(voicePath, result.voice_id);
            }
            resolve(result.voice_id || null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

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

function enqueue(cachePath, volume, remoteUrl) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(QUEUE_DIR, filename), JSON.stringify({ cachePath, volume, remoteUrl: remoteUrl || null }));
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

function postToRemote(cachePath, remoteUrl) {
  return new Promise((resolve) => {
    let audioData;
    try {
      audioData = readFileSync(cachePath);
    } catch {
      return resolve();
    }
    let url;
    try {
      url = new URL(remoteUrl);
    } catch {
      return resolve();
    }
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": audioData.length,
        },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.write(audioData);
    req.end();
  });
}

export function playFile(cachePath, volume, remoteUrl) {
  if (remoteUrl) {
    return postToRemote(cachePath, remoteUrl);
  }
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
        await playFile(entry_data.cachePath, entry_data.volume, entry_data.remoteUrl);
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

function downloadQwen(phrase, cachePath, config, voiceId) {
  return new Promise((resolve) => {
    const qwenUrl = config.qwen_tts_url || "http://localhost:8100";
    const endpoint = `${qwenUrl}/tts`;

    const body = { text: phrase };
    if (voiceId) body.voice_id = voiceId;
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

async function downloadToCache(phrase, cachePath, config, voicePath, ttsParams, packId, refText) {
  if (config.tts_backend === "qwen") {
    const voiceId = await registerVoiceWithQwen(config, voicePath, refText);
    return downloadQwen(phrase, cachePath, config, voiceId);
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
  const refText = (pack && pack.ref_text) || null;
  const customAudioFilter = (pack && pack.audio_filter) || null;
  const postProcessCmd = (pack && pack.post_process) || null;
  const echo = pack ? pack.echo !== false : true;

  try {
    await downloadToCache(phrase, rawPath, config, voicePath, ttsParams, packId, refText);
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
  const backend = config.tts_backend || "qwen";
  const cacheKey = createHash("md5")
    .update(backend + ":" + phrase.toLowerCase() + (ttsParams ? JSON.stringify(ttsParams) : ""))
    .digest("hex");
  const cachePath = join(packCacheDir, `${cacheKey}.wav`);
  const volume = config.volume ?? 0.5;
  const maxCache = config.max_cache_entries ?? DEFAULT_MAX_CACHE;
  const echo = pack ? pack.echo !== false : true;
  const voicePath = (pack && pack.voicePath) || config.voice || "default.wav";
  const refText = (pack && pack.ref_text) || null;
  const customAudioFilter = (pack && pack.audio_filter) || null;
  const postProcessCmd = (pack && pack.post_process) || null;

  // Ensure audio is in cache (all effects baked in at cache time)
  if (existsSync(cachePath)) {
    touchFile(cachePath);
  } else {
    await downloadToCache(phrase, cachePath, config, voicePath, ttsParams, packId, refText);
    if (!existsSync(cachePath)) return false; // download failed
    if (postProcessCmd) postProcess(cachePath, postProcessCmd);
    if (customAudioFilter || echo) applyEcho(cachePath, customAudioFilter);
    normalizeVolume(cachePath);
    evictCache(packCacheDir, maxCache);
  }

  // Enqueue and try to become the player
  const remoteUrl = config.remote_playback_url || null;
  enqueue(cachePath, volume, remoteUrl);
  await processQueue();
}
