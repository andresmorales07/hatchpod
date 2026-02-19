import { memo, useEffect, useRef } from "react";
import type { SlashCommand } from "../types";

interface Props {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export const SlashCommandDropdown = memo(function SlashCommandDropdown({ commands, activeIndex, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll active item into view
  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (commands.length === 0) return null;

  return (
    <div className="slash-dropdown" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          className={`slash-dropdown-item${i === activeIndex ? " active" : ""}`}
          onClick={() => onSelect(cmd)}
        >
          <span className="slash-command-name">/{cmd.name}</span>
          {cmd.description && <span className="slash-command-desc">{cmd.description}</span>}
          {cmd.argumentHint && <span className="slash-command-hint">{cmd.argumentHint}</span>}
        </div>
      ))}
    </div>
  );
});

export function getFilteredCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const filter = input.slice(1);
  if (filter.includes(" ")) return []; // User is typing arguments, not selecting a command
  return commands.filter((cmd) =>
    typeof cmd.name === "string" && cmd.name.toLowerCase().startsWith(filter.toLowerCase()),
  );
}
