import { codexNotifyCommand } from "./codex-notify.js";
import { channelCommand } from "./channel.js";
import { configCommand } from "./config.js";
import { costCommand } from "./cost.js";
import { cursorHookCommand } from "./cursor-hook.js";
import { helpCommand } from "./help.js";
import { hookCommand } from "./hook.js";
import { logCommand } from "./log.js";
import { notificationCommand } from "./notification.js";
import { packCommand } from "./pack.js";
import { setupCommand } from "./setup.js";
import { testCommand } from "./test.js";
import { uninstallCommand } from "./uninstall.js";
import { versionCommand } from "./version.js";
import { voiceCommand } from "./voice.js";
import { volumeCommand } from "./volume.js";

export const COMMANDS = [
  setupCommand,
  hookCommand,
  cursorHookCommand,
  codexNotifyCommand,
  configCommand,
  channelCommand,
  logCommand,
  voiceCommand,
  packCommand,
  volumeCommand,
  notificationCommand,
  testCommand,
  costCommand,
  uninstallCommand,
  helpCommand,
  versionCommand,
];

const COMMAND_LOOKUP = new Map();
for (const command of COMMANDS) {
  COMMAND_LOOKUP.set(command.name, command);
  for (const alias of command.aliases || []) {
    COMMAND_LOOKUP.set(alias, command);
  }
}

export function resolveCommand(name) {
  return COMMAND_LOOKUP.get(name) || null;
}
