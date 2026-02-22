import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { SessionCard } from "./SessionCard";
import { FolderPicker } from "./FolderPicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search } from "lucide-react";

function groupByDate(sessions: { id: string; lastModified: string; createdAt: string; status: string }[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: { label: string; items: typeof sessions }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Older", items: [] },
  ];

  for (const s of sessions) {
    const t = new Date(s.lastModified || s.createdAt).getTime();
    if (t >= today) groups[0].items.push(s);
    else if (t >= yesterday) groups[1].items.push(s);
    else if (t >= weekAgo) groups[2].items.push(s);
    else groups[3].items.push(s);
  }

  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar() {
  const { sessions, activeSessionId, searchQuery, setActiveSession, setSearchQuery, fetchSessions, cwd, browseRoot, setCwd } = useSessionsStore();
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
      });
    } else {
      setActiveSession(id);
      navigate(`/session/${id}`);
    }
  };

  return (
    <div className="flex flex-col h-full w-[280px] border-r border-border bg-card">
      <FolderPicker cwd={cwd} browseRoot={browseRoot} onCwdChange={setCwd} />
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((s) => (
              <SessionCard
                key={s.id}
                session={s as any}
                isActive={s.id === activeSessionId}
                onClick={() => handleSelect(s.id, s.status)}
              />
            ))}
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-4 py-8 text-sm text-muted-foreground text-center">No sessions yet</p>
        )}
      </ScrollArea>
      <div className="p-3 border-t border-border">
        <Button className="w-full" size="sm" onClick={() => navigate("/new")}>
          <Plus className="size-4 mr-2" /> New Session
        </Button>
      </div>
    </div>
  );
}
