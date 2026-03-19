export function formatHelp(commands, pkg) {
  const sections = commands
    .filter((command) => Array.isArray(command.help) && command.help.length > 0)
    .map((command) => command.help.join("\n"));

  return [
    `voxlert v${pkg.version} — Game character voice notifications for Claude Code, Cursor, Codex, pi, and OpenClaw`,
    "",
    "Usage:",
    ...sections,
  ].join("\n");
}

export const helpCommand = {
  name: "help",
  aliases: ["--help", "-h"],
  help: [
    "  voxlert help                Show this help message",
  ],
  skipSetupWizard: true,
  skipUpgradeCheck: false,
  async run(context) {
    console.log(context.formatHelp());
  },
};
