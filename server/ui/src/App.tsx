import { useState, useCallback, useEffect } from "react";
import { SessionList } from "./components/SessionList";
import { ChatView } from "./components/ChatView";
import { FolderPicker } from "./components/FolderPicker";
import "./styles.css";

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem("api_token") ?? "");
  const [authenticated, setAuthenticated] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [cwd, setCwd] = useState("");
  const [browseRoot, setBrowseRoot] = useState("");

  // Fetch server config after authentication to get the actual browse root
  useEffect(() => {
    if (!authenticated) return;
    fetch("/api/config", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.ok ? res.json() : null)
      .then((config) => {
        if (config?.browseRoot) {
          setBrowseRoot(config.browseRoot);
          if (!cwd) setCwd(config.defaultCwd ?? config.browseRoot);
        }
      })
      .catch(() => {});
  }, [authenticated, token]);

  const startSession = useCallback(async (sessionCwd: string) => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: sessionCwd }),
      });
      if (res.ok) {
        const session = await res.json();
        setActiveSessionId(session.id);
        setShowSidebar(false);
      }
    } catch (err) {
      console.error("Failed to start session:", err);
    }
  }, [token]);

  if (!authenticated) {
    return <LoginPage token={token} setToken={setToken} onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <button className="menu-btn" onClick={() => setShowSidebar(!showSidebar)}>
          {showSidebar ? "\u2715" : "\u2630"}
        </button>
        <h1>Hatchpod</h1>
      </header>
      <div className="app-layout">
        <aside className={`sidebar ${showSidebar ? "open" : ""}`}>
          <FolderPicker token={token} cwd={cwd} browseRoot={browseRoot} onCwdChange={setCwd} onStartSession={startSession} />
          <SessionList token={token} cwd={cwd} activeSessionId={activeSessionId} onSelectSession={(id) => { setActiveSessionId(id); setShowSidebar(false); }} />
        </aside>
        <main className="main-panel">
          {activeSessionId ? (
            <ChatView sessionId={activeSessionId} token={token} />
          ) : (
            <div className="empty-state"><p>Create a new session to get started</p></div>
          )}
        </main>
      </div>
    </div>
  );
}

function LoginPage({ token, setToken, onLogin }: { token: string; setToken: (t: string) => void; onLogin: () => void }) {
  const [error, setError] = useState("");
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) { localStorage.setItem("api_token", token); onLogin(); }
      else if (res.status === 401) { setError("Invalid password"); }
      else { setError(`Server error (${res.status})`); }
    } catch { setError("Unable to reach server — check your connection"); }
  };
  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h1>Hatchpod</h1>
        <input type="password" placeholder="API Password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        <button type="submit">Connect</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
