import { useState } from "react";
import { PrismLight, oneDark, detectLanguage } from "@/lib/syntax";
import { cn } from "@/lib/utils";
import { ChevronDown, FileEdit, FilePlus, AlertCircle } from "lucide-react";
import type { ToolResultPart, ToolUsePart } from "@shared/types";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface WriteInput {
  file_path: string;
  content: string;
}

interface Props {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart | null;
}

/** Max lines shown for Write content before truncation. */
const WRITE_PREVIEW_LINES = 25;

const removedBg = "rgba(239, 68, 68, 0.08)";
const addedBg = "rgba(16, 185, 129, 0.08)";

/** Common PrismLight style overrides for diff blocks. */
const codeCustomStyle = {
  margin: 0,
  borderRadius: 0,
  fontSize: "0.8125rem",
  padding: "0.5rem 0",
  background: "transparent",
};

function DiffBlock({
  code,
  language,
  lineBackground,
}: {
  code: string;
  language: string;
  lineBackground: string;
}) {
  if (!code) return null;
  return (
    <PrismLight
      style={oneDark}
      language={language}
      PreTag="div"
      customStyle={codeCustomStyle}
      wrapLines
      lineProps={() => ({
        style: {
          backgroundColor: lineBackground,
          display: "block",
          paddingLeft: "2em",
          paddingRight: "0.75em",
          position: "relative" as const,
        },
      })}
    >
      {code.replace(/\n$/, "")}
    </PrismLight>
  );
}

/** Gutter overlay — CSS pseudo-elements don't work with inline-style renderers,
 *  so we render the gutter character in a positioned wrapper around PrismLight. */
function DiffSection({
  code,
  language,
  lineBackground,
  gutterChar,
}: {
  code: string;
  language: string;
  lineBackground: string;
  gutterChar: string;
}) {
  if (!code) return null;
  const lineCount = code.replace(/\n$/, "").split("\n").length;
  return (
    <div className="relative">
      {/* Gutter column */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[1.5em] flex flex-col items-center select-none pointer-events-none z-10"
        style={{ paddingTop: "0.5rem" }}
        aria-hidden
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <span
            key={i}
            className="text-[0.6875rem] leading-[1.3125rem] font-mono opacity-50"
          >
            {gutterChar}
          </span>
        ))}
      </div>
      <DiffBlock
        code={code}
        language={language}
        lineBackground={lineBackground}
      />
    </div>
  );
}

export function FileDiffCard({ toolUse, toolResult }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const isEdit = toolUse.toolName === "Edit";
  const input = toolUse.input as EditInput | WriteInput | null;
  const filePath = input?.file_path ?? "";
  const basename = filePath.split("/").pop() ?? filePath;
  const language = detectLanguage(filePath);
  const isError = toolResult?.isError ?? false;
  const summary = toolUse.summary?.description ?? "";

  // Edit-specific data
  const editInput = isEdit ? (input as EditInput) : null;
  const oldString = editInput?.old_string ?? "";
  const newString = editInput?.new_string ?? "";

  // Write-specific data
  const writeInput = !isEdit ? (input as WriteInput) : null;
  const fullContent = writeInput?.content ?? "";
  const contentLines = fullContent.replace(/\n$/, "").split("\n");
  const needsTruncation = !isEdit && contentLines.length > WRITE_PREVIEW_LINES;
  const displayContent =
    needsTruncation && !showAll
      ? contentLines.slice(0, WRITE_PREVIEW_LINES).join("\n")
      : fullContent;

  const Icon = isEdit ? FileEdit : FilePlus;

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden text-sm",
        isError
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-card/50",
      )}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Icon className="size-3.5 text-amber-400 shrink-0" />
        <span
          className="font-medium truncate"
          title={filePath}
        >
          {basename}
        </span>
        <span
          className={cn(
            "text-[0.625rem] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0",
            isEdit
              ? "bg-amber-500/15 text-amber-400"
              : "bg-emerald-500/15 text-emerald-400",
          )}
        >
          {isEdit ? "edited" : "created"}
        </span>
        {isError && <AlertCircle className="size-3.5 text-destructive shrink-0" />}
        {summary && filePath !== summary && (
          <span className="text-muted-foreground truncate text-xs font-mono hidden sm:inline">
            {summary}
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground ml-auto shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* Expandable body */}
      {expanded && (
        <div className="border-t border-border overflow-x-auto">
          {isEdit ? (
            <>
              {oldString && (
                <DiffSection
                  code={oldString}
                  language={language}
                  lineBackground={removedBg}
                  gutterChar="−"
                />
              )}
              {oldString && newString && (
                <div className="border-t border-border/50" />
              )}
              {newString && (
                <DiffSection
                  code={newString}
                  language={language}
                  lineBackground={addedBg}
                  gutterChar="+"
                />
              )}
            </>
          ) : (
            <>
              <DiffSection
                code={displayContent}
                language={language}
                lineBackground={addedBg}
                gutterChar="+"
              />
              {needsTruncation && (
                <button
                  className="w-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors border-t border-border/50"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAll(!showAll);
                  }}
                >
                  {showAll
                    ? "Show less"
                    : `${WRITE_PREVIEW_LINES} of ${contentLines.length} lines — Show all`}
                </button>
              )}
            </>
          )}

          {/* Error output */}
          {isError && toolResult?.output && (
            <div className="border-t border-destructive/20 px-3 py-2">
              <pre className="whitespace-pre-wrap font-mono text-xs leading-snug text-destructive">
                {toolResult.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
