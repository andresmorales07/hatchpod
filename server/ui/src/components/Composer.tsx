import { useState, useCallback, useMemo } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { SlashCommandDropdown, getFilteredCommands } from "./SlashCommandDropdown";
import { Button } from "@/components/ui/button";
import { Send, Square } from "lucide-react";
import type { SlashCommand } from "@shared/types";

interface Props {
  slashCommands: SlashCommand[];
  isDisabled: boolean;
  isRunning: boolean;
  viewerMode?: boolean;
  onSend: (text: string) => boolean;
  onInterrupt: () => void;
}

export function Composer({ slashCommands, isDisabled, isRunning, viewerMode, onSend, onInterrupt }: Props) {
  const [input, setInput] = useState("");
  const [dropdownIndex, setDropdownIndex] = useState(0);

  const filtered = useMemo(
    () => slashCommands.length > 0 ? getFilteredCommands(slashCommands, input) : [],
    [slashCommands, input],
  );
  const dropdownVisible = filtered.length > 0;

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setInput(`/${cmd.name} `);
  }, []);

  const effectiveDisabled = viewerMode ? false : isDisabled;
  const effectiveRunning = viewerMode ? false : isRunning;
  const placeholder = viewerMode ? "Type to resume this session..." : "Send a message...";

  const handleSubmit = () => {
    if (effectiveDisabled || !input.trim()) return;
    if (onSend(input.trim())) {
      setInput("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (dropdownVisible) {
      if (e.key === "ArrowDown") { e.preventDefault(); setDropdownIndex((p) => Math.min(p + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setDropdownIndex((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (filtered[dropdownIndex]) selectCommand(filtered[dropdownIndex]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
    } else {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    }
  };

  return (
    <div className="relative shrink-0 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      {dropdownVisible && (
        <SlashCommandDropdown commands={filtered} activeIndex={dropdownIndex} onSelect={selectCommand} />
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-lg">
        <TextareaAutosize
          value={input}
          onChange={(e) => { setInput(e.target.value); setDropdownIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          minRows={1}
          maxRows={8}
          disabled={effectiveDisabled}
          className="flex-1 px-2 py-1.5 bg-transparent text-foreground text-sm font-[inherit] resize-none outline-none leading-snug placeholder:text-muted-foreground disabled:opacity-50"
        />
        {effectiveRunning ? (
          <Button size="icon-sm" variant="destructive" onClick={onInterrupt} className="rounded-lg shrink-0">
            <Square className="size-4" />
          </Button>
        ) : (
          <Button size="icon-sm" onClick={handleSubmit} disabled={!input.trim()} className="rounded-lg shrink-0">
            <Send className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
