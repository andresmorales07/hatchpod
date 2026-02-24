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
export declare const SYSTEM_TAGS: string[];
export declare const STRIP_RE: RegExp;
/** Remove all known system/protocol XML blocks from text. */
export declare function stripSystemTags(text: string): string;
/** Unwrap <local-command-stdout>...</local-command-stdout> to plain text. */
export declare function unwrapStdout(text: string): string;
/**
 * Convert SDK slash-command markup to clean "/cmd args" form.
 *
 *   <command-name>/foo</command-name> ... <command-args>bar</command-args>
 *   →  "/foo bar"
 *
 * Must be called AFTER stripSystemTags() so the `^` anchor works.
 */
export declare function cleanSlashCommand(text: string): string;
/**
 * Full message cleanup pipeline. Strips system tags, unwraps stdout blocks,
 * and converts slash-command markup to clean "/cmd" form.
 */
export declare function cleanMessageText(text: string): string;
