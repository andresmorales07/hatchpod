/**
 * Strip system/protocol XML tags from message text.
 *
 * Claude Code injects various XML tags for internal protocol (hooks, skills,
 * reminders, task notifications, etc.). These should never be visible in
 * the chat UI or API responses.
 */
/**
 * Tags whose opening + content + closing tag should be removed entirely.
 * Add new entries here as Claude Code introduces new protocol tags.
 */
export const SYSTEM_TAGS = [
    "system-reminder",
    "assistant_context",
    "task-notification",
    "user-prompt-submit-hook",
    "EXTREMELY_IMPORTANT",
    "EXTREMELY-IMPORTANT",
    "local-command-caveat",
    "command-message",
    "fast_mode_info",
];
export const STRIP_RE = new RegExp(SYSTEM_TAGS.map((t) => `<${t}>[\\s\\S]*?</${t}>`).join("|"), "g");
/** Remove all known system/protocol XML blocks from text. */
export function stripSystemTags(text) {
    return text.replace(STRIP_RE, "");
}
/** Unwrap <local-command-stdout>...</local-command-stdout> to plain text. */
export function unwrapStdout(text) {
    return text.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, "$1");
}
/**
 * Convert SDK slash-command markup to clean "/cmd args" form.
 *
 *   <command-name>/foo</command-name> ... <command-args>bar</command-args>
 *   →  "/foo bar"
 *
 * Must be called AFTER stripSystemTags() so the `^` anchor works.
 */
export function cleanSlashCommand(text) {
    const m = text.match(/^\s*<command-name>(\/[^<]+)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/);
    if (m) {
        const name = m[1].trim();
        const args = m[2]?.trim();
        return args ? `${name} ${args}` : name;
    }
    return text;
}
/**
 * Full message cleanup pipeline. Strips system tags, unwraps stdout blocks,
 * and converts slash-command markup to clean "/cmd" form.
 */
export function cleanMessageText(text) {
    let cleaned = stripSystemTags(text);
    cleaned = unwrapStdout(cleaned);
    cleaned = cleanSlashCommand(cleaned);
    return cleaned.trim();
}
