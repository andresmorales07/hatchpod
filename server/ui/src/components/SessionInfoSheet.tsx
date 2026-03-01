import { useState } from "react";
import { Drawer } from "vaul";
import { Info, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ModelPicker, modelLabel } from "@/components/ModelPicker";
import { cn } from "@/lib/utils";
import { PERMISSION_MODES } from "@/lib/sessions";
import type { PermissionModeCommon } from "@shared/types";

interface SessionInfoSheetProps {
  currentModel: string | null;
  currentMode: PermissionModeCommon | null;
  contextUsage: { inputTokens: number; contextWindow: number; percentUsed: number } | null;
  connected: boolean;
  status: string;
  supportedModels: Array<{ id: string; name?: string }> | null;
  canSwitchMode: boolean;
  onSetMode: (mode: PermissionModeCommon) => void;
}

const modeLabels: Record<string, string> = {
  plan: "Plan",
  acceptEdits: "Accept Edits",
  bypassPermissions: "Auto",
  default: "Default",
};

/**
 * Mobile-only bottom sheet (vaul Drawer) displaying session metadata:
 * model picker, permission mode, context usage, and connection status.
 * Desktop uses inline header controls in ChatPage instead.
 */
export function SessionInfoSheet({
  currentModel,
  currentMode,
  contextUsage,
  connected,
  status,
  supportedModels,
  canSwitchMode,
  onSetMode,
}: SessionInfoSheetProps) {
  const [open, setOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showModes, setShowModes] = useState(false);

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Trigger asChild>
        <Button variant="ghost" size="icon-sm">
          <Info className="size-4" />
        </Button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border rounded-t-xl max-h-[75vh] flex flex-col">
          <div className="mx-auto w-12 h-1.5 rounded-full bg-muted-foreground/30 my-3 shrink-0" />
          <Drawer.Title className="sr-only">Session Info</Drawer.Title>
          <div className="px-4 pb-6 overflow-y-auto flex flex-col gap-1">
            {/* Model */}
            {currentModel && (
              <div>
                <button
                  className="w-full flex items-center justify-between px-3 py-3 rounded-lg hover:bg-accent transition-colors"
                  onClick={() => setShowModels((v) => !v)}
                >
                  <span className="text-sm text-muted-foreground">Model</span>
                  <span className="flex items-center gap-1 text-sm font-medium">
                    {modelLabel(currentModel, supportedModels?.find((m) => m.id === currentModel)?.name)}
                    <ChevronRight className={cn("size-4 transition-transform", showModels && "rotate-90")} />
                  </span>
                </button>
                {showModels && (
                  <ModelPicker
                    onSelect={() => setShowModels(false)}
                    className="ml-2 border-l border-border"
                  />
                )}
              </div>
            )}

            {/* Permission mode */}
            {currentMode && (
              <div>
                <button
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-3 rounded-lg transition-colors",
                    canSwitchMode ? "hover:bg-accent" : "opacity-60",
                  )}
                  onClick={() => canSwitchMode && setShowModes((v) => !v)}
                  disabled={!canSwitchMode}
                >
                  <span className="text-sm text-muted-foreground">Permission Mode</span>
                  <span className="flex items-center gap-1 text-sm font-medium">
                    {modeLabels[currentMode] || currentMode}
                    {canSwitchMode && <ChevronRight className={cn("size-4 transition-transform", showModes && "rotate-90")} />}
                  </span>
                </button>
                {showModes && (
                  <div className="ml-2 border-l border-border">
                    {PERMISSION_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        className={cn(
                          "w-full px-3 py-2 text-sm text-left transition-colors",
                          currentMode === mode.value
                            ? "bg-primary/10 text-primary font-semibold"
                            : "text-foreground hover:bg-accent",
                        )}
                        onClick={() => {
                          onSetMode(mode.value);
                          setShowModes(false);
                        }}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Context usage */}
            {contextUsage && (
              <div className="px-3 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">Context Usage</span>
                  <span className="text-sm font-medium tabular-nums">{contextUsage.percentUsed}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      contextUsage.percentUsed >= 90
                        ? "bg-red-400"
                        : contextUsage.percentUsed >= 75
                          ? "bg-amber-400"
                          : "bg-primary",
                    )}
                    style={{ width: `${Math.min(contextUsage.percentUsed, 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                  {Math.round(contextUsage.inputTokens / 1000)}k / {Math.round(contextUsage.contextWindow / 1000)}k tokens
                </p>
              </div>
            )}

            {/* Connection status */}
            <div className="flex items-center justify-between px-3 py-3">
              <span className="text-sm text-muted-foreground">Connection</span>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs font-semibold",
                  connected
                    ? "bg-emerald-500/15 text-emerald-400 border-transparent"
                    : status === "history"
                      ? "bg-muted-foreground/10 text-muted-foreground border-transparent"
                      : "bg-red-400/15 text-red-400 border-transparent",
                )}
              >
                {connected ? "Connected" : status === "history" ? "History" : "Offline"}
              </Badge>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
