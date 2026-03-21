import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import select from "@inquirer/select";
import { playFile } from "./audio.js";
import { loadPack } from "./packs.js";
import { CACHE_DIR } from "./paths.js";
import { printStatus, printSuccess, printWarning } from "./setup-ui.js";

const TTS_TEST_PHRASE = "Voxlert TTS check. If you hear this voice, your setup is working.";

export const QWEN_DOCS_URL = "https://github.com/settinghead/voxlert/blob/main/qwen3-tts-server/README.md";
export const CHATTERBOX_DOCS_URL = "https://github.com/settinghead/voxlert/blob/main/docs/chatterbox-tts.md";

function getRequestFunction(url) {
  const urlObj = new URL(url);
  return urlObj.protocol === "https:" ? httpsRequest : httpRequest;
}

function getTtsEndpoint(config, backend) {
  const base = backend === "qwen"
    ? (config.qwen_tts_url || "http://localhost:8100")
    : (config.chatterbox_url || "http://localhost:8004");
  return `${base}/tts`;
}

export function getTtsDocsUrl(backend) {
  return backend === "qwen" ? QWEN_DOCS_URL : CHATTERBOX_DOCS_URL;
}

export function getTtsLabel(backend) {
  return backend === "qwen" ? "Qwen TTS" : "Chatterbox";
}

export function getTtsChoices(currentBackend) {
  return [
    {
      name: currentBackend === "qwen"
        ? "Qwen TTS (recommended, current, more natural voice)"
        : "Qwen TTS (recommended, more natural voice)",
      value: "qwen",
      description: `Setup docs: ${QWEN_DOCS_URL}`,
    },
    {
      name: currentBackend === "chatterbox"
        ? "Chatterbox (current)"
        : "Chatterbox",
      value: "chatterbox",
      description: `Setup docs: ${CHATTERBOX_DOCS_URL}`,
    },
  ];
}

export function probeTtsBackend(config, backend, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const healthUrl = backend === "qwen"
      ? `${config.qwen_tts_url || "http://localhost:8100"}/health`
      : `${config.chatterbox_url || "http://localhost:8004"}/health`;

    let urlObj;
    try {
      urlObj = new URL(healthUrl);
    } catch {
      return resolve(false);
    }

    const reqFn = urlObj.protocol === "https:" ? httpsRequest : httpRequest;
    const req = reqFn(urlObj, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function _registerVoiceForTest(config, pack) {
  return new Promise((resolve) => {
    const voicePath = pack.voicePath;
    const refText = pack.ref_text;
    if (!voicePath || !existsSync(voicePath) || !refText) return resolve(null);

    const qwenUrl = config.qwen_tts_url || "http://localhost:8100";
    const endpoint = `${qwenUrl}/voices`;

    let audioData;
    try { audioData = readFileSync(voicePath); } catch { return resolve(null); }

    const boundary = `----VoxlertBoundary${Date.now()}`;
    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="ref_text"\r\n\r\n${refText}\r\n`,
    ));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    ));
    parts.push(audioData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const url = new URL(endpoint);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          resolve(result.voice_id || null);
        } catch { resolve(null); }
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function requestTtsAudio(config, backend, pack) {
  let voiceId = null;
  if (backend === "qwen") {
    voiceId = await _registerVoiceForTest(config, pack);
  }

  return new Promise((resolve) => {
    const endpoint = getTtsEndpoint(config, backend);
    const body = backend === "qwen"
      ? { text: TTS_TEST_PHRASE, ...(voiceId ? { voice_id: voiceId } : {}) }
      : {
          text: TTS_TEST_PHRASE,
          voice_mode: "predefined",
          predefined_voice_id: pack.voicePath || config.voice || "default.wav",
          output_format: "wav",
          ...(pack.tts_params || {}),
        };
    const payload = JSON.stringify(body);

    let reqFn;
    try {
      reqFn = getRequestFunction(endpoint);
    } catch {
      return resolve(null);
    }

    const req = reqFn(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: backend === "qwen" ? 30000 : 8000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => resolve(null));
      },
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

export async function runTtsSample(config, backend) {
  const pack = loadPack(config);
  const outPath = join(CACHE_DIR, `setup-tts-test-${Date.now()}.wav`);

  try {
    const audio = await requestTtsAudio(config, backend, pack);
    if (!audio || audio.length === 0) {
      return false;
    }
    writeFileSync(outPath, audio);
    await playFile(outPath, config.volume ?? 0.5);
    return true;
  } catch {
    return false;
  } finally {
    if (existsSync(outPath)) {
      try {
        unlinkSync(outPath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

export async function chooseTtsBackend(config, { qwenUp, chatterboxUp }) {
  const detected = [qwenUp && "Qwen TTS", chatterboxUp && "Chatterbox"].filter(Boolean);
  const hint = detected.length > 0
    ? `Detected: ${detected.join(", ")}. `
    : "";

  if (!qwenUp && !chatterboxUp) {
    printStatus("Note", "Local TTS needs a GPU or Apple Silicon. Setup still works \u2014 you'll get text notifications until TTS is running.");
    console.log("");
  }

  return select({
    message: `${hint}Choose the TTS backend. Qwen TTS is recommended for a more natural voice.`,
    choices: getTtsChoices(config.tts_backend),
    default: config.tts_backend || "qwen",
  });
}

export async function verifyTtsSetup(config, backend) {
  const label = getTtsLabel(backend);
  const docsUrl = getTtsDocsUrl(backend);

  const retryOrSkip = [
    { name: "I have set up the TTS server. Try again.", value: "retry" },
    { name: "Skip setup (you won't hear any voice!)", value: "skip" },
  ];

  let attempt = 0;
  while (true) {
    attempt++;
    if (attempt > 1) {
      console.log("\n  ── Retry #" + (attempt - 1) + " ──");
    }
    console.log("");
    process.stdout.write(`  Checking ${label}... `);
    const backendUp = await probeTtsBackend(config, backend);
    console.log(backendUp ? "detected!" : "not running");

    if (!backendUp) {
      printWarning(`${label} is not running yet.`);
      printStatus(`${label} docs`, docsUrl);
      console.log("");
      const action = await select({ message: "What would you like to do?", choices: retryOrSkip });
      if (action === "skip") {
        printWarning("Skipped TTS verification. Voice notifications won't work until the server is running.");
        return;
      }
      continue;
    }

    process.stdout.write(`  Testing ${label} audio... `);
    const ok = await runTtsSample(config, backend);
    console.log(ok ? "played." : "failed.");

    if (!ok) {
      printWarning(`The ${label} test failed.`);
      printStatus(`${label} docs`, docsUrl);
      console.log("");
      const action = await select({ message: "What would you like to do?", choices: retryOrSkip });
      if (action === "skip") {
        printWarning("Skipped TTS verification. Voice notifications won't work until the server is fixed.");
        return;
      }
      continue;
    }

    const heardVoice = await select({
      message: `Did you hear the ${label} voice test?`,
      choices: [
        { name: "Yes", value: "yes" },
        { name: "No, try again", value: "retry" },
        { name: "Skip (you won't hear any voice!)", value: "skip" },
      ],
    });

    if (heardVoice === "yes") {
      printSuccess(`${label} verified.`);
      return;
    }

    if (heardVoice === "skip") {
      printWarning("Skipped TTS verification. Voice notifications won't work until the server is fixed.");
      return;
    }

    printWarning("Still not working? Local TTS requires specific hardware (Apple Silicon or NVIDIA GPU).");
    printStatus("Setup help", "https://github.com/settinghead/voxlert/discussions/6");
    printStatus(`${label} docs`, docsUrl);
    console.log("");
  }
}
