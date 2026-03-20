/**
 * pi-voxlert — Voice notifications for pi coding sessions.
 *
 * Hooks into pi agent lifecycle events and pipes them through the Voxlert CLI
 * to generate contextual, in-character voice notifications spoken by game
 * characters (SHODAN, StarCraft Adjutant, C&C EVA, HEV Suit, etc.).
 *
 * Prerequisites:
 *   npm install -g @settinghead/voxlert
 *   voxlert setup
 *
 * The extension calls `voxlert hook` with the event data on stdin, so whatever
 * TTS backend + voice pack + LLM backend you configured via `voxlert config`
 * is used automatically.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync, spawn } from "node:child_process";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the voxlert binary path, or null if not installed. */
function findVoxlert(): string | null {
  try {
    return execSync("which voxlert", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

/** Pipe an event through `voxlert hook` (fire-and-forget, async). */
function fireVoxlert(
  eventName: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): void {
  const payload = JSON.stringify({
    hook_event_name: eventName,
    cwd,
    source: "pi",
    ...extra,
  });

  const child = spawn("voxlert", ["hook"], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });

  child.stdin.write(payload);
  child.stdin.end();
  child.unref(); // don't block pi on audio playback
}

/** Check if Voxlert CLI is installed and available. */
function isVoxlertAvailable(): boolean {
  return findVoxlert() !== null;
}

/**
 * Extract the last assistant message text from pi's event messages array.
 * Handles both direct message format and session entry format.
 */
function extractLastAssistantText(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    // Handle session entry format: { type: "message", message: { role, content } }
    const actualMsg = msg?.message || msg;

    if (actualMsg?.role === "assistant") {
      const content = actualMsg.content;
      if (typeof content === "string") return content.slice(0, 500);
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .slice(0, 500);
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let available = isVoxlertAvailable();

  // ------------------------------------------------------------------
  // Guided setup: install CLI + run setup --yes
  // ------------------------------------------------------------------
  async function runGuidedSetup(ctx: any): Promise<boolean> {
    // Step 1: Install the CLI
    ctx.ui.notify("Installing @settinghead/voxlert...", "info");
    const install = await pi.exec("npm", ["install", "-g", "@settinghead/voxlert"], {
      timeout: 120_000,
    });
    if (install.code !== 0) {
      ctx.ui.notify(
        `Install failed (exit ${install.code}):\n${install.stderr.slice(0, 300)}`,
        "error",
      );
      return false;
    }

    // Step 2: Run non-interactive setup (downloads voice packs, detects TTS)
    ctx.ui.notify("Running voxlert setup (downloading voice packs, detecting TTS)...", "info");
    const setup = await pi.exec("voxlert", ["setup", "--yes"], { timeout: 120_000 });
    if (setup.code !== 0) {
      ctx.ui.notify(
        `Setup failed (exit ${setup.code}):\n${setup.stderr.slice(0, 300)}`,
        "error",
      );
      return false;
    }

    // Verify it worked
    available = isVoxlertAvailable();
    if (available) {
      ctx.ui.notify(
        "Voxlert installed and configured!\n\n" +
          "Voice notifications will now play when the agent finishes a task.\n" +
          "Run /voxlert test to hear it, or 'voxlert setup' in a terminal for full interactive config.",
        "info",
      );
      ctx.ui.setStatus("voxlert", "🔊 Voxlert");
      return true;
    } else {
      ctx.ui.notify("Install succeeded but voxlert binary not found in PATH.", "error");
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Session start: verify Voxlert is installed, offer setup if not
  // ------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    available = isVoxlertAvailable();
    if (!available) {
      if (!ctx.hasUI) {
        // Non-interactive mode (print mode, JSON mode) — just warn
        return;
      }

      const install = await ctx.ui.confirm(
        "Voxlert Setup",
        "Voxlert CLI not found. Install it now?\n\n" +
          "This will:\n" +
          "  • npm install -g @settinghead/voxlert\n" +
          "  • Download default voice packs (SHODAN, Adjutant, etc.)\n" +
          "  • Auto-detect your TTS backend\n\n" +
          "You can run full interactive setup later with: voxlert setup",
      );

      if (install) {
        await runGuidedSetup(ctx);
      } else {
        ctx.ui.notify(
          "Skipped. Run /voxlert setup anytime, or manually:\n" +
            "  npm install -g @settinghead/voxlert && voxlert setup",
          "info",
        );
      }
    } else {
      ctx.ui.setStatus("voxlert", "🔊 Voxlert");
    }
  });

  // ------------------------------------------------------------------
  // Agent end → "Stop" hook (task finished, waiting for input)
  // Passes last_assistant_message so the LLM can generate a
  // contextual phrase about what just happened.
  // ------------------------------------------------------------------
  pi.on("agent_end", async (event, ctx) => {
    if (!available) return;

    const messages = (event as any).messages || [];
    const lastAssistantMessage = extractLastAssistantText(messages);

    fireVoxlert("Stop", ctx.cwd, {
      last_assistant_message: lastAssistantMessage,
    });
  });

  // ------------------------------------------------------------------
  // Tool errors → "PostToolUseFailure" hook (contextual event)
  // ------------------------------------------------------------------
  pi.on("tool_result", async (event, ctx) => {
    if (!available) return;
    if (event.isError) {
      const text =
        event.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .slice(0, 500) || "";

      fireVoxlert("PostToolUseFailure", ctx.cwd, {
        error_message: `${event.toolName}: ${text}`,
      });
    }
  });

  // ------------------------------------------------------------------
  // Session shutdown → "SessionEnd" hook
  // ------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!available) return;
    fireVoxlert("SessionEnd", ctx.cwd);
  });

  // ------------------------------------------------------------------
  // Context compaction → "PreCompact" hook
  // ------------------------------------------------------------------
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!available) return;
    fireVoxlert("PreCompact", ctx.cwd);
  });

  // ------------------------------------------------------------------
  // /voxlert command — quick controls
  // ------------------------------------------------------------------
  pi.registerCommand("voxlert", {
    description: "Voxlert voice notifications: test, status, or configure",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0];

      if (sub === "setup") {
        if (available) {
          const redo = await ctx.ui.confirm(
            "Voxlert Setup",
            "Voxlert is already installed. Re-run setup with defaults?",
          );
          if (!redo) return;
        }
        await runGuidedSetup(ctx);
        return;
      }

      if (sub === "test") {
        if (!available) {
          ctx.ui.notify("Voxlert CLI not installed. Run /voxlert setup first.", "error");
          return;
        }
        fireVoxlert("Stop", ctx.cwd);
        ctx.ui.notify("Sent test notification.", "info");
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(
          available
            ? "Voxlert is active. Voice notifications will play on agent_end, tool errors, compaction, and session end."
            : "Voxlert CLI not found. Run /voxlert setup to install.",
          available ? "info" : "warning",
        );
        return;
      }

      // Default: show help
      ctx.ui.notify(
        "Usage: /voxlert [setup|test|status]\n" +
          "  setup  — install Voxlert CLI and configure with defaults\n" +
          "  test   — fire a test voice notification\n" +
          "  status — check if Voxlert CLI is available\n" +
          "\nFor full interactive config, run in terminal: voxlert setup",
        "info",
      );
    },
  });

  // ------------------------------------------------------------------
  // voxlert_speak tool — let the LLM speak through Voxlert
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "voxlert_speak",
    label: "Voxlert Speak",
    description:
      "Speak a phrase aloud through Voxlert using the user's configured voice pack and TTS backend. " +
      "Use this when the user asks you to say something out loud, announce something, or test voice notifications.",
    parameters: Type.Object({
      phrase: Type.String({ description: "The phrase to speak aloud (2-12 words work best)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!available) {
        throw new Error(
          "Voxlert CLI not installed. Install with: npm install -g @settinghead/voxlert && voxlert setup",
        );
      }

      fireVoxlert("Stop", ctx.cwd, {
        phrase_override: params.phrase,
      });

      return {
        content: [{ type: "text", text: `Speaking: "${params.phrase}"` }],
        details: { phrase: params.phrase },
      };
    },
  });
}
