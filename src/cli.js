#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { STATE_DIR } from "./paths.js";
import { getUpgradeInfo, printUpgradeNotification } from "./upgrade-check.js";
import { COMMANDS, resolveCommand } from "./commands/index.js";
import { formatHelp } from "./commands/help.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

function isPromptAbort(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  const message = err && typeof err.message === "string" ? err.message : "";
  return name === "ExitPromptError" || message.includes("User force closed the prompt");
}

function createHelpText() {
  return formatHelp(COMMANDS, pkg);
}

async function maybeRunSetup(command) {
  if (command.skipSetupWizard || existsSync(STATE_DIR)) return false;
  const args = process.argv.slice(2);
  const nonInteractive = args.includes("--yes") || args.includes("-y");
  if (nonInteractive) {
    const { runSetup } = await import("./setup.js");
    await runSetup({ nonInteractive: true });
    return true;
  }
  console.log("Welcome to Voxlert! First time here?\n");
  const select = (await import("@inquirer/select")).default;
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Run setup", value: "setup", description: "Configure LLM, voice packs, TTS, and hooks" },
      { name: "Show command list", value: "help", description: "See all available commands" },
    ],
    default: "setup",
  });
  if (action === "help") {
    console.log("");
    console.log(createHelpText());
    return true;
  }
  console.log("");
  const { runSetup } = await import("./setup.js");
  await runSetup();
  return true;
}

(async () => {
  const args = process.argv.slice(2);

  // --onboard flag: run setup wizard directly (supports `npx voxlert --onboard`)
  if (args.includes("--onboard")) {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    return;
  }

  const requested = args[0] || "help";
  const command = resolveCommand(requested);

  const interactiveUpgrade =
    process.stdout.isTTY &&
    (!command || !command.skipUpgradeCheck);
  const upgradePromise = interactiveUpgrade
    ? getUpgradeInfo(pkg.version, pkg.name)
    : null;

  if (!command) {
    console.error(`Unknown command: ${requested}\n`);
    console.log(createHelpText());
    process.exit(1);
  }

  if (await maybeRunSetup(command)) {
    return;
  }

  await command.run({
    args,
    command,
    formatHelp: createHelpText,
    pkg,
  });

  if (upgradePromise) {
    try {
      const info = await upgradePromise;
      if (info) {
        const releaseNotesUrl =
          pkg.repository?.url &&
          String(pkg.repository.url).replace(/\.git$/i, "").replace(/^git\+https:/, "https:");
        printUpgradeNotification(info, {
          packageName: pkg.name,
          releaseNotesUrl: releaseNotesUrl
            ? `${releaseNotesUrl}/releases/latest`
            : undefined,
        });
      }
    } catch {
      // non-fatal: ignore
    }
  }
})().catch((err) => {
  if (isPromptAbort(err)) {
    process.stdout.write("\n");
    process.exit(130);
  }
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
