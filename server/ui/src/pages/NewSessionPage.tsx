import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { FolderPicker } from "@/components/FolderPicker";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import TextareaAutosize from "react-textarea-autosize";

export function NewSessionPage() {
  const { cwd, browseRoot, setCwd, createSession, lastError } = useSessionsStore();
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const sessionId = await createSession({ prompt: prompt.trim() || undefined, cwd });
      if (sessionId) {
        navigate(`/session/${sessionId}`, { replace: true });
      } else {
        setError(lastError ?? "Failed to create session");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-lg font-medium">New Session</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto px-4 py-6 flex flex-col gap-6">
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">Working Directory</label>
            <div className="rounded-lg border border-border overflow-hidden">
              <FolderPicker cwd={cwd} browseRoot={browseRoot} onCwdChange={setCwd} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">Initial Prompt (optional)</label>
            <TextareaAutosize
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What would you like to work on?"
              minRows={3}
              maxRows={10}
              className="w-full px-3 py-2 rounded-lg border border-border bg-card text-foreground text-sm font-[inherit] resize-none outline-none leading-snug focus:border-ring placeholder:text-muted-foreground"
            />
          </div>
          <Button onClick={handleCreate} disabled={creating} className="w-full" size="lg">
            {creating ? "Creating..." : "Create Session"}
          </Button>
          {error && <p className="text-destructive text-sm text-center -mt-3">{error}</p>}
        </div>
      </div>
    </div>
  );
}
