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
  // Session start: verify Voxlert is installed, fire SessionStart
  // ------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    available = isVoxlertAvailable();
    if (!available) {
      ctx.ui.notify(
        "Voxlert not found. Install with: npm install -g @settinghead/voxlert && voxlert setup",
        "warning",
      );
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

      if (sub === "test") {
        if (!available) {
          ctx.ui.notify("Voxlert CLI not installed.", "error");
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
            : "Voxlert CLI not found. Run: npm install -g @settinghead/voxlert && voxlert setup",
          available ? "info" : "warning",
        );
        return;
      }

      // Default: show help
      ctx.ui.notify(
        "Usage: /voxlert [test|status]\n" +
          "  test   — fire a test voice notification\n" +
          "  status — check if Voxlert CLI is available\n" +
          "\nConfigure voice packs, TTS backend, etc. via: voxlert config",
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
