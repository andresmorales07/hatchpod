import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { groupByDate } from "@/lib/sessions";
import { SessionCard } from "@/components/SessionCard";
import { FolderPicker } from "@/components/FolderPicker";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Search, X } from "lucide-react";

export function SessionListPage() {
  const { sessions, activeSessionId, searchQuery, setActiveSession, setSearchQuery, fetchSessions, cwd, browseRoot, setCwd, workspaceFilter, setWorkspaceFilter } = useSessionsStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const name = s.slug || s.summary || s.id;
      return name.toLowerCase().includes(q);
    });
  }, [sessions, searchQuery]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  const handleSelect = (id: string, status: string) => {
    if (status === "history") {
      useSessionsStore.getState().resumeSession(id).then((newId) => {
        if (newId) navigate(`/session/${newId}`);
      }).catch(console.error);
    } else {
      setActiveSession(id);
      navigate(`/session/${id}`);
    }
  };

  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <h1 className="text-lg font-bold text-primary flex-1">Hatchpod</h1>
        <Button size="icon-sm" onClick={() => navigate("/new")}>
          <Plus className="size-5" />
        </Button>
      </header>
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">
          <FolderPicker
            cwd={workspaceFilter ?? cwd}
            browseRoot={browseRoot}
            onCwdChange={(path) => { setWorkspaceFilter(path); setCwd(path); }}
          />
        </div>
        {workspaceFilter && (
          <button
            onClick={() => setWorkspaceFilter(null)}
            title="Show all workspaces"
            className="shrink-0 mr-3 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="px-4 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                isActive={s.id === activeSessionId}
                onClick={() => handleSelect(s.id, s.status)}
              />
            ))}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <p className="text-sm">No sessions yet</p>
            <Button className="mt-4" onClick={() => navigate("/new")}>
              <Plus className="size-4 mr-2" /> Create your first session
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
