/**
 * Shared format definitions for LLM phrase generation.
 *
 * Format  = structural rules (word count, grammar, what to include/omit)
 * Style   = character personality (tone, vocabulary, examples)
 *
 * buildSystemPrompt() composes them into a single system prompt.
 */

const DEFAULT_STYLE =
  "You are a status report assistant.";

const FORMATS = {
  "status-report": [
    "Respond with ONLY 2-8 words as a brief status report.",
    "The phrase MUST end with a past participle OR adjective (but not both).",
    "Before the final word, state WHAT was done. If you can clearly infer WHY it exists — the purpose or goal — include it (e.g. 'item for purpose adjective'). If the purpose is not obvious, omit it and just describe the action.",
    "Do NOT fabricate or guess a purpose. Only include 'for …' when the intent is clearly evident from context.",
    "No punctuation. No quotes. No explanation.",
  ].join(" "),
};

/**
 * Format examples array into prompt text.
 * Each example: { content, format?, response }
 *
 * @param {Array|null} examples
 * @param {string} formatId - only include examples matching this format
 * @returns {string} Formatted examples block, or empty string
 */
function formatExamples(examples, formatId) {
  if (!Array.isArray(examples) || examples.length === 0) return "";
  const matching = examples.filter(
    (ex) => ex.content && ex.response && (!ex.format || ex.format === formatId),
  );
  if (matching.length === 0) return "";
  const lines = matching.map(
    (ex) => `"${ex.content}" → ${ex.response}`,
  );
  return "\n\nExamples:\n" + lines.join("\n");
}

/**
 * Compose a full system prompt from a style string, format id, and examples.
 *
 * @param {string|null} style     - Character personality text (null → default neutral)
 * @param {string}      formatId  - Format key (default: "status-report")
 * @param {Array|null}  examples  - Few-shot examples from pack.json
 * @returns {string} Complete system prompt
 */
export function buildSystemPrompt(style, formatId = "status-report", examples = null) {
  const format = FORMATS[formatId] || FORMATS["status-report"];
  const s = style || DEFAULT_STYLE;
  return format + "\n\n" + s + formatExamples(examples, formatId);
}
