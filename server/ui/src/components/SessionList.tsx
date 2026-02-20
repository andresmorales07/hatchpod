import { useState, useEffect, useCallback } from "react";

interface SessionSummary {
  id: string;
  status: string;
  createdAt: string;
  lastModified: string;
  numTurns: number;
  totalCostUsd: number;
  hasPendingApproval: boolean;
  provider: string;
  slug: string | null;
  summary: string | null;
}

interface Props {
  token: string;
  cwd: string;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onResumeSession: (historySessionId: string) => void;
}

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sessionDisplayName(s: SessionSummary): string {
  if (s.slug) return s.slug;
  if (s.summary) return s.summary;
  return s.id.slice(0, 8);
}

export function SessionList({ token, cwd, activeSessionId, onSelectSession, onResumeSession }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/sessions${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setSessions(await res.json());
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }, [token, cwd]);

  useEffect(() => { fetchSessions(); const interval = setInterval(fetchSessions, 5000); return () => clearInterval(interval); }, [fetchSessions]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt.trim(), cwd }) });
      if (res.ok) { const session = await res.json(); setPrompt(""); onSelectSession(session.id); fetchSessions(); }
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally { setCreating(false); }
  };

  const handleClick = (s: SessionSummary) => {
    if (s.status === "history") {
      onResumeSession(s.id);
    } else {
      onSelectSession(s.id);
    }
  };

  return (
    <div className="session-list-container">
      <div className="session-list">
        {sessions.length === 0 && <p style={{ padding: "1rem", color: "var(--text-muted)" }}>No sessions yet</p>}
        {sessions.map((s) => (
          <div key={s.id} className={`session-item ${s.id === activeSessionId ? "active" : ""}`} onClick={() => handleClick(s)}>
            <div className="session-item-info">
              <div className="session-name">{sessionDisplayName(s)}</div>
              <div className="session-meta">
                <span className="session-time">{relativeTime(s.lastModified || s.createdAt)}</span>
              </div>
            </div>
            <div className="session-badges">
              <span className="provider-badge">{s.provider}</span>
              <span className={`status ${s.status}`}>{s.status}</span>
            </div>
          </div>
        ))}
      </div>
      <form className="new-session-form" onSubmit={handleCreate}>
        <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="New session prompt..." disabled={creating} />
        <button type="submit" disabled={creating || !prompt.trim()}>{creating ? "..." : "New"}</button>
      </form>
    </div>
  );
}
