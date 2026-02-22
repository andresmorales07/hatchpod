import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth";
import { useSessionsStore } from "@/stores/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginPage() {
  const { token, setToken, login } = useAuthStore();
  const fetchConfig = useSessionsStore((s) => s.fetchConfig);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        login();
        await fetchConfig();
        navigate("/");
      } else if (res.status === 401) {
        setError("Invalid password");
      } else {
        setError(`Server error (${res.status})`);
      }
    } catch {
      setError("Unable to reach server — check your connection");
    }
  };

  return (
    <div className="flex items-center justify-center h-dvh p-4">
      <form
        className="bg-card p-8 rounded-xl border border-border w-full max-w-[360px] flex flex-col gap-4 shadow-lg"
        onSubmit={handleSubmit}
      >
        <h1 className="text-2xl font-bold text-center text-primary">Hatchpod</h1>
        <p className="text-sm text-muted-foreground text-center">Enter your API password to connect</p>
        <Input
          type="password"
          placeholder="API Password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        <Button type="submit" className="w-full">Connect</Button>
        {error && <p className="text-destructive text-sm text-center">{error}</p>}
      </form>
    </div>
  );
}
