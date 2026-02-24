import { describe, it, expect } from "vitest";
import { cleanMessageText, stripSystemTags } from "../src/providers/message-cleanup";

describe("stripSystemTags", () => {
  it("strips <system-reminder> blocks", () => {
    const input = "<system-reminder>\nHook output here\n</system-reminder>Hello world";
    expect(stripSystemTags(input)).toBe("Hello world");
  });

  it("strips <task-notification> blocks", () => {
    const input =
      '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>\nDone';
    expect(stripSystemTags(input)).toBe("\nDone");
  });

  it("strips <user-prompt-submit-hook> blocks", () => {
    const input = "<user-prompt-submit-hook>success</user-prompt-submit-hook>My message";
    expect(stripSystemTags(input)).toBe("My message");
  });

  it("strips <EXTREMELY_IMPORTANT> blocks", () => {
    const input = "Before<EXTREMELY_IMPORTANT>secret</EXTREMELY_IMPORTANT>After";
    expect(stripSystemTags(input)).toBe("BeforeAfter");
  });

  it("strips <EXTREMELY-IMPORTANT> blocks (hyphen variant)", () => {
    const input = "<EXTREMELY-IMPORTANT>secret</EXTREMELY-IMPORTANT>After";
    expect(stripSystemTags(input)).toBe("After");
  });

  it("strips <assistant_context> blocks", () => {
    const input = "<assistant_context>context here</assistant_context>Response";
    expect(stripSystemTags(input)).toBe("Response");
  });

  it("strips <local-command-caveat> blocks", () => {
    const input = "<local-command-caveat>LLM only</local-command-caveat>Visible text";
    expect(stripSystemTags(input)).toBe("Visible text");
  });

  it("strips <command-message> blocks", () => {
    const input = "<command-name>/foo</command-name><command-message>skill content</command-message>";
    expect(stripSystemTags(input)).toBe("<command-name>/foo</command-name>");
  });

  it("strips <fast_mode_info> blocks", () => {
    const input = "<fast_mode_info>\nFast mode uses same model.\n</fast_mode_info>Message";
    expect(stripSystemTags(input)).toBe("Message");
  });

  it("strips multiple different system tags in one message", () => {
    const input =
      "<system-reminder>reminder</system-reminder>Hello<task-notification>notif</task-notification> world";
    expect(stripSystemTags(input)).toBe("Hello world");
  });

  it("strips multiple instances of the same tag", () => {
    const input =
      "<system-reminder>first</system-reminder>A<system-reminder>second</system-reminder>B";
    expect(stripSystemTags(input)).toBe("AB");
  });

  it("preserves text without any system tags", () => {
    expect(stripSystemTags("Just a normal message")).toBe("Just a normal message");
  });

  it("preserves standard HTML tags", () => {
    const input = "<div>hello</div> <span>world</span>";
    expect(stripSystemTags(input)).toBe(input);
  });
});

describe("cleanMessageText", () => {
  it("strips system tags and trims whitespace", () => {
    const input = "  <system-reminder>hidden</system-reminder>  Hello  ";
    expect(cleanMessageText(input)).toBe("Hello");
  });

  it("unwraps <local-command-stdout> to plain text", () => {
    const input = "<local-command-stdout>file contents here</local-command-stdout>";
    expect(cleanMessageText(input)).toBe("file contents here");
  });

  it("converts slash-command markup to /cmd", () => {
    const input = "<command-name>/dev-server</command-name><command-message>skill body</command-message>";
    expect(cleanMessageText(input)).toBe("/dev-server");
  });

  it("converts slash-command with args", () => {
    const input =
      "<command-name>/build</command-name><command-message>body</command-message><command-args>--fast</command-args>";
    expect(cleanMessageText(input)).toBe("/build --fast");
  });

  it("handles system-reminder wrapping a slash-command (the real-world bug)", () => {
    const input =
      "<system-reminder>Hook success</system-reminder><command-name>/dev-server</command-name><command-message>Start the dev server...</command-message>";
    expect(cleanMessageText(input)).toBe("/dev-server");
  });

  it("handles multiple system tags around a slash-command", () => {
    const input =
      "<system-reminder>first</system-reminder><system-reminder>second</system-reminder><command-name>/test</command-name><command-message>body</command-message><command-args>unit</command-args>";
    expect(cleanMessageText(input)).toBe("/test unit");
  });

  it("returns empty string for messages that are only system tags", () => {
    const input = "<system-reminder>hidden</system-reminder><task-notification>notif</task-notification>";
    expect(cleanMessageText(input)).toBe("");
  });

  it("preserves code blocks containing XML-like content", () => {
    const input = "Here is code:\n```xml\n<config>value</config>\n```";
    expect(cleanMessageText(input)).toBe(input);
  });
});
