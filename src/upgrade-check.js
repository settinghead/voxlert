/**
 * Upgrade check: fetch latest version from npm registry and show a terminal notification
 * when a newer version is available. Uses a cache file to avoid hitting the registry every run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "./paths.js";

const NPM_REGISTRY = "https://registry.npmjs.org";
const CACHE_FILE = join(STATE_DIR, "upgrade-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Parse "x.y.z" into [x, y, z]; non-numeric parts become 0. */
function parseVersion(v) {
  const parts = String(v).split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** True if latest > current (semver-ish). */
function isNewer(latest, current) {
  const [lMajor, lMinor, lPatch] = parseVersion(latest);
  const [cMajor, cMinor, cPatch] = parseVersion(current);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

/**
 * Fetch latest version from npm registry.
 * @param {string} packageName - e.g. "@settinghead/voxlert"
 * @returns {{ latest: string } | null}
 */
async function fetchLatestVersion(packageName) {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(packageName)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data["dist-tags"]?.latest;
    return typeof latest === "string" ? { latest } : null;
  } catch {
    return null;
  }
}

/**
 * Get upgrade info: use cache if fresh, else fetch from registry.
 * @param {string} currentVersion - e.g. "0.3.2"
 * @param {string} packageName - e.g. "@settinghead/voxlert"
 * @returns {Promise<{ current: string, latest: string } | null>} null if no upgrade or error
 */
export async function getUpgradeInfo(currentVersion, packageName) {
  const now = Date.now();
  let latest = null;

  if (existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (now - (cache.checkedAt || 0) < CACHE_TTL_MS && cache.latest)
        latest = cache.latest;
    } catch {}
  }

  if (latest === null) {
    const result = await fetchLatestVersion(packageName);
    if (!result) return null;
    latest = result.latest;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ latest, checkedAt: now }),
        "utf-8"
      );
    } catch {}
  }

  if (!isNewer(latest, currentVersion)) return null;
  return { current: currentVersion, latest };
}

/** ANSI codes for terminal styling (no-op when not TTY). */
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
  grey: "\x1b[90m",
};

/**
 * Print upgrade notification to stdout, styled with horizontal separator lines:
 * yellow lines above and below, bold header, version info, install command, changelog link.
 * Only uses colors when stdout is TTY.
 */
export function printUpgradeNotification(info, options = {}) {
  const { packageName = "@settinghead/voxlert", releaseNotesUrl } = options;
  const useColor = process.stdout.isTTY;
  const c = useColor ? ansi : { reset: "", bold: "", dim: "", cyan: "", yellow: "", white: "", grey: "" };

  const installCmd = `npm install -g ${packageName}`;
  const url =
    releaseNotesUrl ||
    `https://github.com/settinghead/voxlert/releases/latest`;

  const rule = `${c.yellow}${"─".repeat(60)}${c.reset}`;

  console.log("");
  console.log(rule);
  console.log("");
  console.log(`  ${c.bold}${c.yellow}Update Available${c.reset}`);
  console.log(`  New version ${c.bold}${info.latest}${c.reset} is available. Run: ${c.cyan}${installCmd}${c.reset}`);
  console.log(`  Changelog:`);
  console.log(`  ${c.cyan}${url}${c.reset}`);
  console.log("");
  console.log(rule);
  console.log("");
}
