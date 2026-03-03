import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  statSync,
  utimesSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
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
  // Pad 100ms of silence so ffplay -autoexit doesn't clip the echo tail
  return "aecho=0.8:0.88:40|75:0.4|0.25,apad=pad_dur=0.1";
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

function enqueue(cachePath, volume, echo, volumeOffsetDb) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(QUEUE_DIR, filename), JSON.stringify({ cachePath, volume, echo, volumeOffsetDb }));
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

function playFile(cachePath, volume, echo, volumeOffsetDb) {
  return new Promise((resolve) => {
    if (!existsSync(cachePath)) return resolve();
    const volPct = String(Math.round(parseFloat(volume) * 100));
    try {
      const ffplayArgs = ["-nodisp", "-autoexit", "-volume", volPct];

      // Build audio filter chain: volume compensation + optional echo
      const filters = [];
      if (volumeOffsetDb && volumeOffsetDb !== 0) {
        filters.push(`volume=${volumeOffsetDb}dB`);
      }
      if (echo) {
        filters.push(audioFilter());
      }
      if (filters.length > 0) {
        ffplayArgs.push("-af", filters.join(","));
      }
      ffplayArgs.push(cachePath);

      const proc = spawn("ffplay", ffplayArgs, {
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.on("error", () => {
        // ffplay not available — fall back to afplay (no echo)
        const fallback = spawn("afplay", ["-v", String(volume), cachePath], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        fallback.on("error", () => resolve());
        fallback.on("close", () => resolve());
      });
      proc.on("close", () => resolve());
    } catch {
      resolve();
    }
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
        await playFile(entry_data.cachePath, entry_data.volume, entry_data.echo !== false, entry_data.volumeOffsetDb || 0);
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

function downloadToCache(phrase, cachePath, config, voicePath) {
  return new Promise((resolve) => {
    const chatterboxUrl = config.chatterbox_url || "http://localhost:8004";
    const endpoint = `${chatterboxUrl}/v1/audio/speech`;

    const payload = JSON.stringify({
      input: phrase,
      voice: voicePath || config.voice || "default.wav",
      model: "chatterbox-turbo",
      response_format: "wav",
    });

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

// --- Public API ---

export async function speakPhrase(phrase, config, pack) {
  const packId = (pack && pack.id) || "_default";
  const packCacheDir = join(CACHE_DIR, packId);
  mkdirSync(packCacheDir, { recursive: true });

  const cacheKey = createHash("md5")
    .update(phrase.toLowerCase())
    .digest("hex");
  const cachePath = join(packCacheDir, `${cacheKey}.wav`);
  const volume = config.volume ?? 0.5;
  const maxCache = config.max_cache_entries ?? DEFAULT_MAX_CACHE;
  const echo = pack ? pack.echo !== false : true;
  const voicePath = (pack && pack.voicePath) || config.voice || "default.wav";
  const volumeOffsetDb = (pack && pack.volumeOffsetDb) || 0;

  // Ensure audio is in cache
  if (existsSync(cachePath)) {
    touchFile(cachePath);
  } else {
    await downloadToCache(phrase, cachePath, config, voicePath);
    if (!existsSync(cachePath)) return; // download failed
    evictCache(packCacheDir, maxCache);
  }

  // Enqueue and try to become the player
  enqueue(cachePath, volume, echo, volumeOffsetDb);
  await processQueue();
}
