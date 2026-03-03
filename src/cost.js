import { readFileSync, writeFileSync } from "fs";
import { USAGE_FILE } from "./paths.js";

// Fallback prices per 1M tokens [prompt, completion] in USD
// Used only for old records missing usage.cost and when OpenRouter API is unreachable
const FALLBACK_PRICES = {
  "google/gemini-2.0-flash-001": [0.10, 0.40],
  "openai/gpt-4o-mini": [0.15, 0.60],
  "anthropic/claude-3.5-haiku": [0.80, 4.00],
};

let priceCache = null;
let priceCacheTime = 0;
const CACHE_TTL = 3600_000; // 1 hour

async function fetchPricing() {
  const now = Date.now();
  if (priceCache && (now - priceCacheTime) < CACHE_TTL) {
    return priceCache;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const table = {};
    for (const model of json.data) {
      const p = model.pricing;
      if (p && p.prompt && p.completion) {
        table[model.id] = [
          parseFloat(p.prompt) * 1_000_000,
          parseFloat(p.completion) * 1_000_000,
        ];
      }
    }
    priceCache = table;
    priceCacheTime = now;
    return table;
  } catch {
    return priceCache || FALLBACK_PRICES;
  }
}

export function loadUsage() {
  try {
    const raw = readFileSync(USAGE_FILE, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function resetUsage() {
  writeFileSync(USAGE_FILE, "");
}

export async function formatCost() {
  const entries = loadUsage();
  if (!entries.length) {
    return "No usage recorded yet.";
  }

  // Check if any entries need price-table estimation
  const needsEstimation = entries.some((e) => e.cost == null);
  const prices = needsEstimation ? await fetchPricing() : null;

  const byModel = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;

  for (const e of entries) {
    const m = e.model || "unknown";
    if (!byModel[m]) byModel[m] = { prompt: 0, completion: 0, total: 0, calls: 0, cost: 0, estimated: 0 };
    byModel[m].prompt += e.prompt_tokens || 0;
    byModel[m].completion += e.completion_tokens || 0;
    byModel[m].total += e.total_tokens || 0;
    byModel[m].calls++;
    if (e.cost != null) {
      byModel[m].cost += e.cost;
    } else {
      // Estimate from price table for old records
      const mp = prices[m];
      if (mp) {
        byModel[m].cost += ((e.prompt_tokens || 0) * mp[0] + (e.completion_tokens || 0) * mp[1]) / 1_000_000;
        byModel[m].estimated++;
      } else {
        byModel[m].estimated++;
      }
    }
    totalPrompt += e.prompt_tokens || 0;
    totalCompletion += e.completion_tokens || 0;
    totalTokens += e.total_tokens || 0;
  }

  const lines = ["Usage Summary", "=".repeat(40)];

  let grandCost = 0;
  let totalEstimated = 0;

  for (const [model, stats] of Object.entries(byModel)) {
    lines.push(`\nModel: ${model}`);
    lines.push(`  Calls: ${stats.calls}`);
    lines.push(`  Prompt tokens: ${stats.prompt.toLocaleString()}`);
    lines.push(`  Completion tokens: ${stats.completion.toLocaleString()}`);
    lines.push(`  Total tokens: ${stats.total.toLocaleString()}`);
    lines.push(`  Cost: $${stats.cost.toFixed(6)}${stats.estimated ? ` (${stats.estimated} call${stats.estimated > 1 ? "s" : ""} estimated)` : ""}`);
    grandCost += stats.cost;
    totalEstimated += stats.estimated;
  }

  lines.push(`\n${"=".repeat(40)}`);
  lines.push(`Total calls: ${entries.length}`);
  lines.push(`Total tokens: ${totalTokens.toLocaleString()} (${totalPrompt.toLocaleString()} prompt + ${totalCompletion.toLocaleString()} completion)`);
  lines.push(`Total cost: $${grandCost.toFixed(6)}${totalEstimated ? ` (${totalEstimated} call${totalEstimated > 1 ? "s" : ""} estimated from price table)` : ""}`);

  return lines.join("\n");
}
