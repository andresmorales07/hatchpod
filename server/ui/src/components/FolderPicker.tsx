import { useState, useEffect, useCallback } from "react";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import { ChevronRight, FolderOpen } from "lucide-react";

interface Props {
  cwd: string;
  browseRoot: string;
  onCwdChange: (cwd: string) => void;
}

export function FolderPicker({ cwd, browseRoot, onCwdChange }: Props) {
  const token = useAuthStore((s) => s.token);
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootName = browseRoot.split("/").filter(Boolean).pop() ?? "root";
  const relPath = cwd.startsWith(browseRoot) ? cwd.slice(browseRoot.length).replace(/^\//, "") : "";
  const segments = relPath ? relPath.split("/") : [];

  const fetchDirs = useCallback(async (rel: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = rel ? `?path=${encodeURIComponent(rel)}` : "";
      const res = await fetch(`/api/browse${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) { useAuthStore.getState().logout(); return; }
      if (res.ok) {
        const body = await res.json();
        setDirs(Array.isArray(body.dirs) ? body.dirs : []);
      } else {
        setError(`Failed to load directories (${res.status})`);
        setDirs([]);
      }
    } catch {
      setError("Unable to reach server");
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchDirs(relPath);
  }, [open, relPath, fetchDirs]);

  const navigateTo = (rel: string) => {
    onCwdChange(rel ? `${browseRoot}/${rel}` : browseRoot);
  };

  if (!browseRoot) return null;

  return (
    <div className="border-b border-border">
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-accent/50 transition-colors"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <FolderOpen className="size-4 text-muted-foreground shrink-0" />
        <span className="flex items-center gap-0.5 min-w-0 overflow-hidden font-mono text-xs">
          <span
            className={cn("cursor-pointer hover:text-primary", segments.length === 0 ? "text-foreground" : "text-muted-foreground")}
            onClick={(e) => { e.stopPropagation(); navigateTo(""); }}
          >
            {rootName}
          </span>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center">
              <ChevronRight className="size-3 text-muted-foreground mx-0.5" />
              <span
                className={cn("cursor-pointer hover:text-primary", i === segments.length - 1 ? "text-foreground" : "text-muted-foreground")}
                onClick={(e) => { e.stopPropagation(); navigateTo(segments.slice(0, i + 1).join("/")); }}
              >
                {seg}
              </span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="max-h-[200px] overflow-y-auto border-t border-border">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {!loading && !error && dirs.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No subdirectories</div>}
          {!loading && dirs.map((dir) => (
            <button
              key={dir}
              className="w-full flex items-center gap-2 px-3 py-1.5 pl-8 text-sm font-mono text-left hover:bg-accent/50 hover:text-primary transition-colors"
              onClick={() => navigateTo(relPath ? `${relPath}/${dir}` : dir)}
              type="button"
            >
              {dir}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
