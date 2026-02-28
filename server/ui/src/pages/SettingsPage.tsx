import { useState, useEffect } from "react";
import { useSettingsStore } from "@/stores/settings";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Moon, Sun, Terminal, Info, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsPage() {
  const { theme, terminalFontSize, terminalScrollback, terminalShell, claudeModel, claudeEffort, updateSettings } =
    useSettingsStore();
  const { version, browseRoot } = useSessionsStore();

  // Local form state — updated on change, synced to server on blur
  const [localFontSize, setLocalFontSize] = useState(String(terminalFontSize));
  const [localScrollback, setLocalScrollback] = useState(String(terminalScrollback));
  const [localShell, setLocalShell] = useState(terminalShell);

  // Re-sync local state when store values change (e.g. after fetchSettings resolves)
  useEffect(() => { setLocalFontSize(String(terminalFontSize)); }, [terminalFontSize]);
  useEffect(() => { setLocalScrollback(String(terminalScrollback)); }, [terminalScrollback]);
  useEffect(() => { setLocalShell(terminalShell); }, [terminalShell]);

  const commitFontSize = () => {
    const n = parseInt(localFontSize, 10);
    if (!isNaN(n) && n >= 10 && n <= 20) {
      updateSettings({ terminalFontSize: n });
    } else {
      setLocalFontSize(String(terminalFontSize));
    }
  };

  const commitScrollback = () => {
    const n = parseInt(localScrollback, 10);
    if (!isNaN(n) && n >= 100 && n <= 10000) {
      updateSettings({ terminalScrollback: n });
    } else {
      setLocalScrollback(String(terminalScrollback));
    }
  };

  const commitShell = () => {
    const trimmed = localShell.trim();
    if (trimmed.length > 0) {
      updateSettings({ terminalShell: trimmed });
    } else {
      setLocalShell(terminalShell);
    }
  };

  const handleModelChange = (model: typeof claudeModel) => {
    const updates: Parameters<typeof updateSettings>[0] = { claudeModel: model };
    if (model !== "claude-opus-4-6" && claudeEffort === "max") {
      updates.claudeEffort = "high";
    }
    updateSettings(updates);
  };

  const handleEffortChange = (effort: typeof claudeEffort) => {
    updateSettings({ claudeEffort: effort });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-background">
      <div className="max-w-2xl w-full mx-auto px-4 py-6 flex flex-col gap-4">

        <h1 className="text-lg font-semibold">Settings</h1>

        {/* Appearance */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sun className="size-4 text-muted-foreground" />
              <CardTitle>Appearance</CardTitle>
            </div>
            <CardDescription>Choose your preferred color theme.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                size="sm"
                className="gap-2"
                onClick={() => updateSettings({ theme: "dark" })}
              >
                <Moon className="size-4" />
                Dark
              </Button>
              <Button
                variant={theme === "light" ? "default" : "outline"}
                size="sm"
                className="gap-2"
                onClick={() => updateSettings({ theme: "light" })}
              >
                <Sun className="size-4" />
                Light
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Claude */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-muted-foreground" />
              <CardTitle>Claude</CardTitle>
            </div>
            <CardDescription>Default model and effort for new sessions.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <p className="text-sm font-medium mb-2">Model</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "Auto", value: undefined },
                  { label: "Haiku", value: "claude-haiku-4-5-20251001" as const },
                  { label: "Sonnet", value: "claude-sonnet-4-6" as const },
                  { label: "Opus", value: "claude-opus-4-6" as const },
                ].map(({ label, value }) => (
                  <button
                    key={label}
                    onClick={() => handleModelChange(value)}
                    className={cn(
                      "px-3 py-2 rounded-lg border text-sm font-medium transition-colors",
                      claudeModel === value
                        ? "bg-primary/15 border-primary text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Effort</p>
              <div className="flex flex-wrap gap-2">
                {(["low", "medium", "high", "max"] as const).map((effort) => {
                  const isMaxDisabled = effort === "max" && claudeModel !== "claude-opus-4-6";
                  return (
                    <button
                      key={effort}
                      onClick={() => !isMaxDisabled && handleEffortChange(effort)}
                      disabled={isMaxDisabled}
                      className={cn(
                        "px-3 py-2 rounded-lg border text-sm font-medium transition-colors capitalize",
                        claudeEffort === effort && !isMaxDisabled
                          ? "bg-primary/15 border-primary text-primary"
                          : isMaxDisabled
                            ? "border-border text-muted-foreground opacity-40 cursor-not-allowed"
                            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      )}
                    >
                      {effort}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-2">Max effort is only available with Opus.</p>
            </div>
          </CardContent>
        </Card>

        {/* Terminal */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-muted-foreground" />
              <CardTitle>Terminal</CardTitle>
            </div>
            <CardDescription>Configure the embedded terminal defaults.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="font-size">
                  Font size <span className="text-muted-foreground font-normal">(10–20 px)</span>
                </label>
                <Input
                  id="font-size"
                  type="number"
                  min={10}
                  max={20}
                  value={localFontSize}
                  onChange={(e) => setLocalFontSize(e.target.value)}
                  onBlur={commitFontSize}
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="scrollback">
                  Scrollback <span className="text-muted-foreground font-normal">(lines)</span>
                </label>
                <Input
                  id="scrollback"
                  type="number"
                  min={100}
                  max={10000}
                  value={localScrollback}
                  onChange={(e) => setLocalScrollback(e.target.value)}
                  onBlur={commitScrollback}
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium" htmlFor="shell">
                  Default shell
                </label>
                <Input
                  id="shell"
                  type="text"
                  value={localShell}
                  onChange={(e) => setLocalShell(e.target.value)}
                  onBlur={commitShell}
                  className="h-8 text-sm font-mono"
                  placeholder="/bin/bash"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* About */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Info className="size-4 text-muted-foreground" />
              <CardTitle>About</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono">{version ? `v${version}` : "—"}</dd>
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="font-mono truncate">{browseRoot || "—"}</dd>
            </dl>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
