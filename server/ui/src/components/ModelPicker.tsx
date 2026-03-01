import { useSessionsStore } from "@/stores/sessions";
import { useMessagesStore } from "@/stores/messages";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

/** Map a model ID to a short display label.
 *  Priority: explicit display name > derived from ID pattern > raw ID. */
export function modelLabel(id: string, name?: string): string {
  if (name) return name;
  // Derive from ID: "claude-opus-4-6-20250514" → "Opus 4.6", "claude-sonnet-4-20250514" → "Sonnet 4"
  const match = id.match(/claude-(\w+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8,})?$/);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`;
  }
  return id;
}

interface ModelPickerProps {
  onSelect?: () => void;
  className?: string;
}

export function ModelPicker({ onSelect, className }: ModelPickerProps) {
  const supportedModels = useSessionsStore((s) => s.supportedModels);
  const currentModel = useMessagesStore((s) => s.currentModel);
  const setModel = useMessagesStore((s) => s.setModel);

  if (!supportedModels || supportedModels.length === 0) return null;

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      {supportedModels.map((m) => {
        const isActive = currentModel === m.id;
        return (
          <button
            key={m.id}
            className={cn(
              "w-full px-3 py-2 text-sm text-left transition-colors flex items-center gap-2",
              isActive
                ? "bg-primary/10 text-primary font-semibold"
                : "text-foreground hover:bg-accent",
            )}
            onClick={() => {
              setModel(m.id);
              onSelect?.();
            }}
          >
            <span className="flex-1">{modelLabel(m.id, m.name)}</span>
            {isActive && <Check className="size-4 shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}
