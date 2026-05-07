import select from "@inquirer/select";
import { loadConfig, saveConfig } from "../config.js";
import {
  channelPreset,
  channelsForPreset,
  formatChannels,
} from "../channels.js";

async function channelPick() {
  const config = loadConfig(process.cwd());
  const currentPreset = channelPreset(config.output_channels);
  const chosen = await select({
    message: "Audio delivery channels",
    choices: [
      {
        value: "local",
        name: "Local machine only",
        description: "Play through speakers on this machine",
      },
      {
        value: "local_phone",
        name: "Local machine + Benchday phone",
        description: "Play locally and relay audio to the Benchday app",
      },
      {
        value: "phone",
        name: "Benchday phone only",
        description: "Send audio to the Benchday app; no local playback",
      },
    ],
    default: currentPreset === "custom" ? "local" : currentPreset,
  });

  config.output_channels = channelsForPreset(chosen);
  saveConfig(config);

  console.log(`Channels: ${formatChannels(config.output_channels)}`);
  if (config.output_channels.includes("benchday_phone")) {
    console.log(`Benchday hub: ${config.hub_url || "http://100.64.0.2:7654"}`);
    console.log(`Benchday node: ${config.benchday_node || config.benchday_daemon_id || "(not set)"}`);
  }
}

export const channelCommand = {
  name: "channel",
  aliases: ["channels", "destination", "destinations"],
  help: [
    "  voxlert channel             Choose audio destination (local / Benchday phone / both)",
  ],
  skipSetupWizard: true,
  skipUpgradeCheck: false,
  async run() {
    await channelPick();
  },
};
