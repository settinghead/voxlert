import {
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { CACHE_DIR, QUEUE_DIR, LOCK_FILE } from "./paths.js";

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

function playFile(cachePath, volume) {
  return new Promise((resolve) => {
    if (!existsSync(cachePath)) return resolve();
    const volPct = String(Math.round(parseFloat(volume) * 100));
    try {
      const proc = spawn(
        "ffplay",
        [
          "-nodisp",
          "-autoexit",
          "-volume",
          volPct,
          "-af",
          audioFilter(),
          cachePath,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
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
        const { cachePath, volume } = JSON.parse(
          readFileSync(entryPath, "utf-8"),
        );
        unlinkSync(entryPath);
        await playFile(cachePath, volume);
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

function downloadToCache(phrase, cachePath, config) {
  return new Promise((resolve) => {
    const chatterboxUrl = config.chatterbox_url || "http://localhost:8004";
    const endpoint = `${chatterboxUrl}/v1/audio/speech`;

    const payload = JSON.stringify({
      input: phrase,
      voice: config.voice || "default.wav",
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

export async function speakPhrase(phrase, config) {
  mkdirSync(CACHE_DIR, { recursive: true });

  const cacheKey = createHash("md5")
    .update(phrase.toLowerCase())
    .digest("hex");
  const cachePath = join(CACHE_DIR, `${cacheKey}.wav`);
  const volume = config.volume ?? 0.5;

  // Ensure audio is in cache
  if (!existsSync(cachePath)) {
    await downloadToCache(phrase, cachePath, config);
  }
  if (!existsSync(cachePath)) return; // download failed

  // Enqueue and try to become the player
  enqueue(cachePath, volume);
  await processQueue();
}
