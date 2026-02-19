import { useState, useEffect, useCallback } from "react";

interface Props {
  token: string;
  cwd: string;
  browseRoot: string;
  onCwdChange: (cwd: string) => void;
  onStartSession: (cwd: string) => void;
}

export function FolderPicker({ token, cwd, browseRoot, onCwdChange, onStartSession }: Props) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Derive the display name from the last segment of browseRoot
  const rootName = browseRoot.split("/").filter(Boolean).pop() ?? "root";

  // Relative path from browse root
  const relPath = cwd.startsWith(browseRoot)
    ? cwd.slice(browseRoot.length).replace(/^\//, "")
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
      } else {
        setDirs([]);
      }
    } catch (err) {
      console.error("Failed to browse:", err);
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchDirs(relPath);
  }, [open, relPath, fetchDirs]);

  const navigateTo = (rel: string) => {
    const newCwd = rel ? `${browseRoot}/${rel}` : browseRoot;
    onCwdChange(newCwd);
  };

  if (!browseRoot) return null;

  return (
    <div className="folder-picker">
      <div className="folder-picker-header">
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
              {rootName}
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
        <button
          className="folder-picker-start"
          onClick={() => onStartSession(cwd)}
          type="button"
          title="Start session here"
        >
          &#9654;
        </button>
      </div>
      {open && (
        <div className="folder-picker-list">
          {loading && <div className="folder-picker-loading">Loading...</div>}
          {!loading && dirs.length === 0 && (
            <div className="folder-picker-empty">No subdirectories</div>
          )}
          {!loading && dirs.map((dir) => {
            const dirCwd = relPath ? `${browseRoot}/${relPath}/${dir}` : `${browseRoot}/${dir}`;
            return (
              <div key={dir} className="folder-picker-item-row">
                <button
                  className="folder-picker-item"
                  onClick={() => navigateTo(relPath ? `${relPath}/${dir}` : dir)}
                  type="button"
                >
                  {dir}
                </button>
                <button
                  className="folder-picker-start"
                  onClick={() => onStartSession(dirCwd)}
                  type="button"
                  title="Start session in this folder"
                >
                  &#9654;
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
