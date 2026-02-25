import { useState } from "react";
import { ChevronDown, ChevronUp, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

interface GitFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  staged: boolean;
}

interface GitDiffStat {
  files: GitFileStat[];
  totalInsertions: number;
  totalDeletions: number;
}

interface Props {
  stat: GitDiffStat;
}

export function GitDiffBar({ stat }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (stat.files.length === 0) return null;

  const fileCount = stat.files.length;
  const hasInsertions = stat.totalInsertions > 0;
  const hasDeletions = stat.totalDeletions > 0;

  return (
    <div className="shrink-0 border-t border-border/50">
      <div className="max-w-3xl mx-auto px-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span>
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </span>
          {(hasInsertions || hasDeletions) && (
            <span className="text-muted-foreground/60">&middot;</span>
          )}
          {hasInsertions && (
            <span className="text-emerald-400">+{stat.totalInsertions}</span>
          )}
          {hasDeletions && (
            <span className="text-red-400">-{stat.totalDeletions}</span>
          )}
          <span className="ml-auto">
            {expanded ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
          </span>
        </button>

        {expanded && (
          <div className="pb-2 space-y-0.5">
            {stat.files.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-2 text-xs font-mono"
              >
                <span className="w-16 text-right shrink-0 tabular-nums">
                  {file.binary ? (
                    <span className="text-muted-foreground">bin</span>
                  ) : file.untracked ? (
                    <span className="text-blue-400">new</span>
                  ) : (
                    <>
                      {file.insertions > 0 && (
                        <span className="text-emerald-400">
                          +{file.insertions}
                        </span>
                      )}
                      {file.insertions > 0 && file.deletions > 0 && " "}
                      {file.deletions > 0 && (
                        <span className="text-red-400">
                          -{file.deletions}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span
                  className={cn(
                    "truncate",
                    file.staged
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                  title={file.path}
                >
                  {file.path}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
