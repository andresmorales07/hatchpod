import { useEffect, useRef } from "react";
import type { SlashCommand } from "../types";

interface Props {
  commands: SlashCommand[];
  filter: string;
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashCommandDropdown({ commands, filter, activeIndex, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = commands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(filter.toLowerCase()),
  );

  // Scroll active item into view
  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (filtered.length === 0) return null;

  return (
    <div className="slash-dropdown" ref={listRef} onMouseDown={(e) => e.preventDefault()}>
      {filtered.map((cmd, i) => (
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
}

export function getFilteredCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const filter = input.slice(1);
  return commands.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(filter.toLowerCase()),
  );
}
