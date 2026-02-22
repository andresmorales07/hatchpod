import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionsStore } from "@/stores/sessions";
import { groupByDate } from "@/lib/sessions";
import { SessionCard } from "./SessionCard";
import { FolderPicker } from "./FolderPicker";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, PanelLeftClose, PanelLeftOpen } from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ collapsed, onToggleCollapse }: SidebarProps) {
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
      }).catch(console.error);
    } else {
      setActiveSession(id);
      navigate(`/session/${id}`);
    }
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center py-2 gap-2 w-[60px] border-r border-border bg-card shrink-0 transition-all duration-200">
        <Button variant="ghost" size="icon-sm" onClick={onToggleCollapse} className="shrink-0" title="Expand sidebar">
          <PanelLeftOpen className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/new")} className="shrink-0" title="New Session">
          <Plus className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-[280px] border-r border-border bg-card shrink-0 transition-all duration-200">
      <div className="flex items-center gap-1 px-2 pt-2 pb-0">
        <Button variant="ghost" size="icon-sm" onClick={onToggleCollapse} className="shrink-0" title="Collapse sidebar">
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
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
                session={s}
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
