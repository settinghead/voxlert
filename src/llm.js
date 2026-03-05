import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { COLLECT_DIR, STATE_DIR, USAGE_FILE } from "./paths.js";
import { buildSystemPrompt } from "./formats.js";
import { getProvider, getApiKey, getModel, formatRequestBody, parseResponse, getEndpointUrl } from "./providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

function saveLlmPair(messages, responseText, model, config) {
  if (!config.collect_llm_data) return;
  try {
    mkdirSync(COLLECT_DIR, { recursive: true });
    const record = {
      timestamp: Date.now() / 1000,
      version: pkg.version,
      model,
      messages,
      response: responseText,
    };
    const filename = `${Date.now()}.json`;
    writeFileSync(
      join(COLLECT_DIR, filename),
      JSON.stringify(record, null, 2),
    );
  } catch {
    // ignore
  }
}

function logUsage(model, usage) {
  if (!usage) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      model,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      cost: usage.cost != null ? usage.cost : undefined,
    });
    appendFileSync(USAGE_FILE, record + "\n");
  } catch {
    // best-effort
  }
}

export function extractContext(eventData) {
  const event = eventData.hook_event_name || "";

  if (event === "Stop") {
    const msg = eventData.last_assistant_message || "";
    if (msg) {
      return `${msg.slice(0, 300)}`;
    }
    return null;
  }

  if (event === "PostToolUseFailure") {
    const err = eventData.error_message || "";
    if (err) {
      return `Tool failed: ${err.slice(0, 280)}`;
    }
    return null;
  }

  return null;
}

function cleanPhrase(raw) {
  let phrase = raw.trim().replace(/^["'.,!;:]+|["'.,!;:]+$/g, "").trim();
  const words = phrase.split(/\s+/).slice(0, 8);
  return words.length ? words.join(" ") : null;
}

/**
 * Generic cloud LLM request — works with any provider in providers.js.
 */
function generatePhraseCloud(context, config, style, llmTemperature, examples) {
  return new Promise((resolve) => {
    const backendId = config.llm_backend || "openrouter";
    const provider = getProvider(backendId);
    if (!provider) return resolve({ phrase: null, fallbackReason: "unknown_provider", detail: backendId });

    const apiKey = getApiKey(config);
    if (!apiKey) return resolve({ phrase: null, fallbackReason: "no_api_key" });

    const model = getModel(config);
    const messages = [
      { role: "system", content: buildSystemPrompt(style, "status-report", examples) },
      { role: "user", content: context },
    ];
    const temperature = llmTemperature != null ? llmTemperature : 0.9;
    const payload = formatRequestBody(provider, model, messages, 30, temperature);

    let url;
    try {
      url = new URL(getEndpointUrl(provider));
    } catch {
      return resolve({ phrase: null, fallbackReason: "invalid_base_url", detail: provider.baseUrl });
    }

    const authHeaders = provider.authHeader(apiKey);
    const headers = {
      ...authHeaders,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };

    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const req = reqFn(
      url,
      { method: "POST", headers, timeout: 5000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            const parsed = parseResponse(provider, result);
            logUsage(model, parsed.usage);
            const phrase = cleanPhrase(parsed.text);
            saveLlmPair(messages, parsed.text, model, config);
            if (phrase) {
              resolve({ phrase, fallbackReason: null, usage: parsed.usage });
            } else {
              resolve({ phrase: null, fallbackReason: "empty_response", detail: result, usage: parsed.usage });
            }
          } catch (err) {
            resolve({ phrase: null, fallbackReason: "parse_error", detail: `${err.message}; body=${data.slice(0, 200)}` });
          }
        });
      },
    );

    req.on("error", (err) => resolve({ phrase: null, fallbackReason: "request_error", detail: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ phrase: null, fallbackReason: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

function generatePhraseLocal(context, config, style, llmTemperature, examples) {
  return new Promise((resolve) => {
    const local = config.local_api || {};
    const baseUrl = local.base_url || "http://localhost:8000";
    const model = local.model || "default";
    const maxTokens = local.max_tokens || 50;
    const timeout = local.timeout || 15000;

    const messages = [
      { role: "system", content: buildSystemPrompt(style, "status-report", examples) },
      { role: "user", content: context },
    ];

    const payload = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: llmTemperature != null ? llmTemperature : 0.9,
    });

    let url;
    try {
      url = new URL("/v1/chat/completions", baseUrl);
    } catch {
      return resolve({ phrase: null, fallbackReason: "invalid_base_url", detail: baseUrl });
    }

    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const req = reqFn(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            const usage = result.usage || null;
            logUsage(model, usage);
            const phrase = cleanPhrase(result.choices[0].message.content);
            saveLlmPair(messages, result.choices[0].message.content, model, config);
            if (phrase) {
              resolve({ phrase, fallbackReason: null, usage });
            } else {
              resolve({ phrase: null, fallbackReason: "empty_response", detail: result, usage });
            }
          } catch (err) {
            resolve({ phrase: null, fallbackReason: "parse_error", detail: `${err.message}; body=${data.slice(0, 200)}` });
          }
        });
      },
    );

    req.on("error", (err) => resolve({ phrase: null, fallbackReason: "request_error", detail: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ phrase: null, fallbackReason: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

// Backward-compatible export
export { generatePhraseCloud as generatePhraseLlm };

export function generatePhrase(context, config, style, llmTemperature, examples) {
  const backend = config.llm_backend || "openrouter";
  if (backend === "local") {
    return generatePhraseLocal(context, config, style, llmTemperature, examples);
  }
  return generatePhraseCloud(context, config, style, llmTemperature, examples);
}
