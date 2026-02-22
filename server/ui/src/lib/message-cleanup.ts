/**
 * Strip system/protocol XML tags from message text before rendering.
 *
 * Claude Code injects various XML tags for internal protocol (hooks, skills,
 * reminders, task notifications, etc.).  These should never be visible in
 * the chat UI.
 *
 * NOTE: Keep the SYSTEM_TAGS list in sync with
 *       server/src/providers/claude-adapter.ts stripSystemTags().
 */

/**
 * Tags whose opening + content + closing tag should be removed entirely.
 * Add new entries here as Claude Code introduces new protocol tags.
 */
const SYSTEM_TAGS = [
  // System injections
  "system-reminder",
  "assistant_context",
  // Task / background-agent notifications
  "task-notification",
  // Hook output
  "user-prompt-submit-hook",
  // Emphasis wrappers injected by system prompts
  "EXTREMELY_IMPORTANT",
  "EXTREMELY-IMPORTANT",
  // SDK internal
  "local-command-caveat",
  // Skill / slash-command protocol
  "command-message",
  // fast_mode_info
  "fast_mode_info",
];

/** Regex that matches `<tag>...content...</tag>` for every tag in SYSTEM_TAGS. */
const STRIP_RE = new RegExp(
  SYSTEM_TAGS.map((t) => `<${t}>[\\s\\S]*?</${t}>`).join("|"),
  "g",
);

/**
 * Remove all known system/protocol XML blocks from text.
 * Safe to call on any message — only removes tags from the explicit list.
 */
export function stripSystemTags(text: string): string {
  return text.replace(STRIP_RE, "");
}

/**
 * Convert SDK slash-command markup to clean "/cmd args" form.
 *
 *   <command-name>/foo</command-name> ... <command-args>bar</command-args>
 *   →  "/foo bar"
 *
 * Must be called AFTER stripSystemTags() so the `^` anchor works.
 */
function cleanSlashCommand(text: string): string {
  const m = text.match(
    /^\s*<command-name>(\/[^<]+)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/,
  );
  if (m) {
    const name = m[1].trim();
    const args = m[2]?.trim();
    return args ? `${name} ${args}` : name;
  }
  return text;
}

/**
 * Unwrap <local-command-stdout>...</local-command-stdout> to plain text.
 */
function unwrapStdout(text: string): string {
  return text.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, "$1");
}

/**
 * Full message cleanup pipeline. Strips system tags, unwraps stdout blocks,
 * and converts slash-command markup to clean "/cmd" form.
 *
 * Apply to both user and assistant message text before rendering.
 */
export function cleanMessageText(text: string): string {
  let cleaned = stripSystemTags(text);
  cleaned = unwrapStdout(cleaned);
  cleaned = cleanSlashCommand(cleaned);
  return cleaned.trim();
}
