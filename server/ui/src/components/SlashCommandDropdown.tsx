import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SlashCommand } from "@shared/types";

interface Props {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export const SlashCommandDropdown = memo(function SlashCommandDropdown({ commands, activeIndex, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 max-h-60 overflow-y-auto bg-card border border-border border-b-0 shadow-[0_-4px_16px_rgba(0,0,0,0.3)] z-20"
      ref={listRef}
      onMouseDown={(e) => e.preventDefault()}
    >
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          className={cn(
            "flex items-center gap-3 px-4 py-2 cursor-pointer",
            i === activeIndex && "bg-accent"
          )}
          onClick={() => onSelect(cmd)}
        >
          <span className="font-mono font-semibold text-primary whitespace-nowrap text-sm">/{cmd.name}</span>
          {cmd.description && <span className="text-muted-foreground text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{cmd.description}</span>}
          {cmd.argumentHint && <span className="text-muted-foreground italic text-xs whitespace-nowrap ml-auto">{cmd.argumentHint}</span>}
        </div>
      ))}
    </div>
  );
});

export function getFilteredCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const filter = input.slice(1);
  if (filter.includes(" ")) return [];
  return commands.filter((cmd) =>
    typeof cmd.name === "string" && cmd.name.toLowerCase().startsWith(filter.toLowerCase()),
  );
}
