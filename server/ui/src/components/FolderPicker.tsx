import { useState, useEffect, useCallback } from "react";

interface Props {
  token: string;
  cwd: string;
  onCwdChange: (cwd: string) => void;
}

const BROWSE_ROOT = "/home/claude/workspace";

export function FolderPicker({ token, cwd, onCwdChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Relative path from browse root
  const relPath = cwd.startsWith(BROWSE_ROOT)
    ? cwd.slice(BROWSE_ROOT.length).replace(/^\//, "")
    : "";

  const segments = relPath ? relPath.split("/") : [];

  const fetchDirs = useCallback(async (rel: string) => {
    setLoading(true);
    try {
      const params = rel ? `?path=${encodeURIComponent(rel)}` : "";
      const res = await fetch(`/api/browse${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const body = await res.json();
        setDirs(body.dirs);
      }
    } catch (err) {
      console.error("Failed to browse:", err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchDirs(relPath);
  }, [open, relPath, fetchDirs]);

  const navigateTo = (rel: string) => {
    const newCwd = rel ? `${BROWSE_ROOT}/${rel}` : BROWSE_ROOT;
    onCwdChange(newCwd);
  };

  return (
    <div className="folder-picker">
      <button
        className="folder-picker-toggle"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="folder-icon">{open ? "\u25BE" : "\u25B8"}</span>
        <span className="folder-breadcrumb">
          <span
            className="breadcrumb-segment clickable"
            onClick={(e) => { e.stopPropagation(); navigateTo(""); }}
          >
            workspace
          </span>
          {segments.map((seg, i) => (
            <span key={i}>
              <span className="breadcrumb-sep">/</span>
              <span
                className="breadcrumb-segment clickable"
                onClick={(e) => {
                  e.stopPropagation();
                  navigateTo(segments.slice(0, i + 1).join("/"));
                }}
              >
                {seg}
              </span>
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="folder-picker-list">
          {loading && <div className="folder-picker-loading">Loading...</div>}
          {!loading && dirs.length === 0 && (
            <div className="folder-picker-empty">No subdirectories</div>
          )}
          {!loading && dirs.map((dir) => (
            <button
              key={dir}
              className="folder-picker-item"
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
