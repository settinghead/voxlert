import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_FILE = join(CODEX_DIR, "config.toml");

function splitTopLevelPrefix(content) {
  const lines = content.split("\n");
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstSectionIndex === -1) {
    return { prefixLines: lines, suffixLines: [] };
  }
  return {
    prefixLines: lines.slice(0, firstSectionIndex),
    suffixLines: lines.slice(firstSectionIndex),
  };
}

function countBrackets(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
  }
  return depth;
}

function replaceTopLevelArrayAssignment(content, key, renderedValue) {
  const { prefixLines, suffixLines } = splitTopLevelPrefix(content);
  const output = [];
  let i = 0;
  let replaced = false;

  while (i < prefixLines.length) {
    const line = prefixLines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      output.push(line);
      i++;
      continue;
    }

    const match = line.match(new RegExp(`^(\\s*)${key}\\s*=`));
    if (!match) {
      output.push(line);
      i++;
      continue;
    }

    replaced = true;
    output.push(`${match[1]}${key} = ${renderedValue}`);

    let depth = countBrackets(line.slice(line.indexOf("=") + 1));
    i++;
    while (depth > 0 && i < prefixLines.length) {
      depth += countBrackets(prefixLines[i]);
      i++;
    }
  }

  if (!replaced) {
    while (output.length > 0 && output[output.length - 1] === "") {
      output.pop();
    }
    if (output.length > 0) output.push("");
    output.push(`${key} = ${renderedValue}`);
    if (suffixLines.length > 0) output.push("");
  }

  return [...output, ...suffixLines].join("\n");
}

function removeTopLevelAssignment(content, key) {
  const { prefixLines, suffixLines } = splitTopLevelPrefix(content);
  const output = [];
  let i = 0;
  let removed = false;

  while (i < prefixLines.length) {
    const line = prefixLines[i];
    const match = line.match(new RegExp(`^(\\s*)${key}\\s*=`));
    if (!match) {
      output.push(line);
      i++;
      continue;
    }

    removed = true;
    let depth = countBrackets(line.slice(line.indexOf("=") + 1));
    i++;
    while (depth > 0 && i < prefixLines.length) {
      depth += countBrackets(prefixLines[i]);
      i++;
    }
  }

  while (output.length > 0 && output[output.length - 1] === "" && suffixLines.length > 0 && /^\s*\[/.test(suffixLines[0])) {
    output.pop();
  }

  return {
    removed,
    content: [...output, ...suffixLines].join("\n"),
  };
}

function loadCodexConfig() {
  try {
    return readFileSync(CODEX_CONFIG_FILE, "utf-8");
  } catch {
    return "";
  }
}

function saveCodexConfig(content) {
  mkdirSync(CODEX_DIR, { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  writeFileSync(CODEX_CONFIG_FILE, normalized);
}

function renderTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function getCodexConfigPath() {
  return CODEX_CONFIG_FILE;
}

export function registerCodexNotify(commandArgs) {
  const current = loadCodexConfig();
  const next = replaceTopLevelArrayAssignment(current, "notify", renderTomlStringArray(commandArgs));
  saveCodexConfig(next);
  return existsSync(CODEX_CONFIG_FILE);
}

export function unregisterCodexNotify() {
  if (!existsSync(CODEX_CONFIG_FILE)) return false;
  const current = loadCodexConfig();
  const { removed, content } = removeTopLevelAssignment(current, "notify");
  if (!removed) return false;
  saveCodexConfig(content);
  return true;
}
