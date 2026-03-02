import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { CACHE_DIR, PID_FILE } from "./paths.js";

function killPreviousSound() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore
  }
}

function savePid(pid) {
  try {
    writeFileSync(PID_FILE, String(pid));
  } catch {
    // ignore
  }
}

function echoFilter() {
  // Short multi-tap echo: two taps at 40ms and 75ms with moderate decay
  return "aecho=0.8:0.88:40|75:0.4|0.25";
}

function playCached(cachePath, volume) {
  killPreviousSound();
  const volPct = String(Math.round(parseFloat(volume) * 100));
  try {
    const proc = spawn(
      "ffplay",
      ["-nodisp", "-autoexit", "-volume", volPct, "-af", echoFilter(), cachePath],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    proc.on("error", () => {
      // ffplay not available — fall back to afplay (no echo)
      const fallback = spawn("afplay", ["-v", String(volume), cachePath], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      fallback.on("error", () => {});
      savePid(fallback.pid);
    });
    savePid(proc.pid);
  } catch {
    // ignore
  }
}

function streamAndPlay(res, cachePath, volume) {
  return new Promise((resolve) => {
    killPreviousSound();
    const volPct = String(Math.round(parseFloat(volume) * 100));

    let player;
    try {
      player = spawn(
        "ffplay",
        ["-nodisp", "-autoexit", "-volume", volPct, "-af", echoFilter(), "-i", "pipe:0"],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
    } catch {
      resolve(false);
      return;
    }

    player.on("error", () => resolve(false));
    savePid(player.pid);

    // Collect chunks for cache file while piping to player
    const chunks = [];
    res.on("data", (chunk) => {
      chunks.push(chunk);
      try {
        player.stdin.write(chunk);
      } catch {
        // broken pipe
      }
    });

    res.on("end", () => {
      try {
        player.stdin.end();
      } catch {
        // ignore
      }
      // Write cache file
      try {
        writeFileSync(cachePath, Buffer.concat(chunks));
      } catch {
        // ignore
      }
      resolve(true);
    });

    res.on("error", () => {
      try {
        player.stdin.end();
      } catch {
        // ignore
      }
      resolve(false);
    });
  });
}

export function speakPhrase(phrase, config) {
  return new Promise((resolve) => {
    mkdirSync(CACHE_DIR, { recursive: true });

    const cacheKey = createHash("md5").update(phrase.toLowerCase()).digest("hex");
    const cachePath = join(CACHE_DIR, `${cacheKey}.wav`);
    const volume = config.volume ?? 0.5;

    // Cached: play immediately
    if (existsSync(cachePath)) {
      playCached(cachePath, volume);
      return resolve();
    }

    // Fetch from TTS server
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
      async (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve();
        }

        // Try streaming playback via ffplay
        const streamed = await streamAndPlay(res, cachePath, volume);
        if (!streamed) {
          // ffplay not available — fall back to full download + afplay
          // streamAndPlay already wrote the cache if data arrived
          if (existsSync(cachePath)) {
            playCached(cachePath, volume);
          }
        }
        resolve();
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
