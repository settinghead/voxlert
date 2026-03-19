import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PI_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");
const PI_EXTENSION_FILE = join(PI_EXTENSIONS_DIR, "voxlert.ts");

/**
 * The extension source is bundled at ../pi-package/extensions/voxlert.ts
 * relative to this file (cli/src/).
 */
const EXTENSION_SRC = join(__dirname, "..", "pi-package", "extensions", "voxlert.ts");

/**
 * Check if the Voxlert extension is installed in pi's extensions directory.
 */
export function hasPiExtension() {
  return existsSync(PI_EXTENSION_FILE);
}

/**
 * Install the Voxlert extension to ~/.pi/agent/extensions/voxlert.ts.
 * Copies the bundled extension source file.
 * @returns {boolean} true if installed successfully
 */
export function installPiExtension() {
  if (!existsSync(EXTENSION_SRC)) return false;
  mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });
  const content = readFileSync(EXTENSION_SRC, "utf-8");
  writeFileSync(PI_EXTENSION_FILE, content);
  return true;
}

/**
 * Remove the Voxlert extension from ~/.pi/agent/extensions/.
 * @returns {boolean} true if a file was removed
 */
export function removePiExtension() {
  if (!existsSync(PI_EXTENSION_FILE)) return false;
  rmSync(PI_EXTENSION_FILE);
  return true;
}
