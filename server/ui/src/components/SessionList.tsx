import { useState, useEffect, useCallback } from "react";

interface SessionSummary { id: string; status: string; createdAt: string; numTurns: number; totalCostUsd: number; hasPendingApproval: boolean; }
interface Props { token: string; activeSessionId: string | null; onSelectSession: (id: string) => void; }

export function SessionList({ token, activeSessionId, onSelectSession }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setSessions(await res.json());
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    }
  }, [token]);

  useEffect(() => { fetchSessions(); const interval = setInterval(fetchSessions, 5000); return () => clearInterval(interval); }, [fetchSessions]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt.trim() }) });
      if (res.ok) { const session = await res.json(); setPrompt(""); onSelectSession(session.id); fetchSessions(); }
    } catch (err) {
      console.error("Failed to create session:", err);
    } finally { setCreating(false); }
  };

  return (
    <div className="session-list-container">
      <div className="session-list">
        {sessions.length === 0 && <p style={{ padding: "1rem", color: "var(--text-muted)" }}>No sessions yet</p>}
        {sessions.map((s) => (
          <div key={s.id} className={`session-item ${s.id === activeSessionId ? "active" : ""}`} onClick={() => onSelectSession(s.id)}>
            <div>
              <div style={{ fontSize: "0.8125rem", fontFamily: "var(--mono)" }}>{s.id.slice(0, 8)}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{new Date(s.createdAt).toLocaleTimeString()}</div>
            </div>
            <span className={`status ${s.status}`}>{s.status}</span>
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
