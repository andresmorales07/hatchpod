import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Shield } from "lucide-react";
import { useSwipe } from "@/hooks/useSwipe";
import { useIsDesktop } from "@/hooks/useMediaQuery";

interface Props {
  toolName: string; toolUseId: string; input: unknown;
  onApprove: (toolUseId: string, answers?: Record<string, string>) => void;
  onApproveAlways: (toolUseId: string) => void;
  onDeny: (toolUseId: string) => void;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function isAskUserQuestion(input: unknown): input is { questions: Question[] } {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  return Array.isArray(obj.questions) && obj.questions.length > 0 &&
    obj.questions.every((q: unknown) => {
      if (!q || typeof q !== "object") return false;
      const qObj = q as Record<string, unknown>;
      return typeof qObj.question === "string" &&
        Array.isArray(qObj.options) &&
        qObj.options.every((o: unknown) =>
          !!o && typeof o === "object" && typeof (o as Record<string, unknown>).label === "string"
        );
    });
}

const OTHER_KEY = "\0__other__";

function AskUserQuestionUI({ questions, toolUseId, onApprove, onDeny }: {
  questions: Question[]; toolUseId: string;
  onApprove: Props["onApprove"]; onDeny: Props["onDeny"];
}) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    for (let i = 0; i < questions.length; i++) init[i] = new Set();
    return init;
  });
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    for (let i = 0; i < questions.length; i++) init[i] = "";
    return init;
  });

  const toggleOption = useCallback((idx: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const current = new Set(prev[idx]);
      if (label === OTHER_KEY) {
        if (current.has(OTHER_KEY)) current.delete(OTHER_KEY);
        else { if (!multiSelect) current.clear(); current.add(OTHER_KEY); }
      } else if (multiSelect) {
        current.delete(OTHER_KEY);
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [idx]: current };
    });
  }, []);

  const allAnswered = questions.every((q, i) => {
    const sel = selections[i];
    if (sel.size === 0) return false;
    if (sel.has(OTHER_KEY) && !otherTexts[i].trim()) return false;
    return true;
  });

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const sel = selections[i];
      if (sel.has(OTHER_KEY)) {
        answers[q.question] = otherTexts[i].trim();
      } else {
        answers[q.question] = Array.from(sel).join(", ");
      }
    }
    onApprove(toolUseId, answers);
  };

  return (
    <div className="p-4 mx-4 my-2 bg-card border border-border shadow-lg rounded-xl">
      {questions.map((q, i) => (
        <div key={i} className={cn("mb-4", i === questions.length - 1 && "mb-3")}>
          {q.header && (
            <div className="text-[0.6875rem] font-bold uppercase tracking-widest text-primary mb-1">{q.header}</div>
          )}
          <div className="text-[0.9375rem] text-foreground mb-2.5 leading-snug">{q.question}</div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt, optIdx) => {
              const selected = selections[i].has(opt.label);
              return (
                <button
                  key={optIdx}
                  className={cn(
                    "flex flex-col gap-0.5 px-3 py-2 rounded-lg border bg-input text-foreground cursor-pointer text-left transition-colors duration-150",
                    selected ? "border-primary bg-primary/12" : "border-border hover:border-primary"
                  )}
                  onClick={() => toggleOption(i, opt.label, q.multiSelect)}
                >
                  <span className="text-sm font-semibold">{opt.label}</span>
                  {opt.description && <span className="text-xs text-muted-foreground leading-tight">{opt.description}</span>}
                </button>
              );
            })}
            <button
              className={cn(
                "flex flex-col gap-0.5 px-3 py-2 rounded-lg border bg-input text-foreground cursor-pointer text-left transition-colors duration-150",
                selections[i].has(OTHER_KEY) ? "border-primary bg-primary/12" : "border-border hover:border-primary"
              )}
              onClick={() => toggleOption(i, OTHER_KEY, q.multiSelect)}
            >
              <span className="text-sm font-semibold">Other</span>
            </button>
          </div>
          {selections[i].has(OTHER_KEY) && (
            <textarea
              className="w-full mt-1.5 px-2 py-2 rounded-lg border border-border bg-input text-foreground text-sm font-[inherit] resize-y outline-none focus:border-ring"
              placeholder="Type your answer..."
              value={otherTexts[i]}
              onChange={(e) => setOtherTexts((prev) => ({ ...prev, [i]: e.target.value }))}
              rows={2}
            />
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={!allAnswered} className="h-10 bg-emerald-500 text-black hover:bg-emerald-400">Submit</Button>
        <Button size="sm" variant="destructive" onClick={() => onDeny(toolUseId)} className="h-10">Dismiss</Button>
      </div>
    </div>
  );
}

function SwipeableToolApproval({ toolName, toolUseId, input, onApprove, onApproveAlways, onDeny }: Props) {
  const [offsetX, setOffsetX] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const swipe = useSwipe({
    threshold: 80,
    onSwipeRight: () => { setOffsetX(0); onApprove(toolUseId); },
    onSwipeLeft: () => { setOffsetX(0); onDeny(toolUseId); },
    onProgress: (dx) => setOffsetX(dx),
    onCancel: () => setOffsetX(0),
  });

  const approveVisible = offsetX > 10;
  const denyVisible = offsetX < -10;
  const opacity = Math.min(Math.abs(offsetX) / 80, 1);

  return (
    <div className="relative mx-4 my-2 overflow-hidden rounded-xl">
      {/* Green approve hint */}
      <div
        className="absolute inset-0 rounded-xl bg-emerald-500/30 flex items-center pl-4"
        style={{ opacity: approveVisible ? opacity : 0 }}
        aria-hidden
      >
        <span className="text-emerald-400 font-semibold text-sm">Approve</span>
      </div>
      {/* Red deny hint */}
      <div
        className="absolute inset-0 rounded-xl bg-destructive/30 flex items-center justify-end pr-4"
        style={{ opacity: denyVisible ? opacity : 0 }}
        aria-hidden
      >
        <span className="text-destructive font-semibold text-sm">Deny</span>
      </div>
      <div
        ref={cardRef}
        {...swipe}
        style={{ transform: `translateX(${offsetX}px)`, transition: offsetX === 0 ? "transform 0.2s ease" : "none" }}
        className="bg-card border border-border shadow-lg rounded-xl p-4 touch-pan-y"
      >
        <div className="font-semibold text-amber-400 mb-2 flex items-center gap-2"><Shield className="size-4" />Tool: {toolName}</div>
        <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto mb-3">
          {JSON.stringify(input, null, 2)}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onApprove(toolUseId)} className="h-10 bg-emerald-500 text-black hover:bg-emerald-400">Approve</Button>
          <Button size="sm" onClick={() => onApproveAlways(toolUseId)} className="h-10 bg-amber-400 text-black hover:bg-amber-300">Always Allow</Button>
          <Button size="sm" variant="destructive" onClick={() => onDeny(toolUseId)} className="h-10">Deny</Button>
        </div>
      </div>
    </div>
  );
}

export function ToolApproval({ toolName, toolUseId, input, onApprove, onApproveAlways, onDeny }: Props) {
  const isDesktop = useIsDesktop();

  if (toolName === "AskUserQuestion" && isAskUserQuestion(input)) {
    return <AskUserQuestionUI questions={input.questions} toolUseId={toolUseId} onApprove={onApprove} onDeny={onDeny} />;
  }

  if (!isDesktop) {
    return (
      <SwipeableToolApproval
        toolName={toolName} toolUseId={toolUseId} input={input}
        onApprove={onApprove} onApproveAlways={onApproveAlways} onDeny={onDeny}
      />
    );
  }

  return (
    <div className="p-4 mx-4 my-2 bg-card border border-border shadow-lg rounded-xl">
      <div className="font-semibold text-amber-400 mb-2 flex items-center gap-2"><Shield className="size-4" />Tool: {toolName}</div>
      <div className="font-mono text-xs text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto mb-3">
        {JSON.stringify(input, null, 2)}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onApprove(toolUseId)} className="h-10 bg-emerald-500 text-black hover:bg-emerald-400">Approve</Button>
        <Button size="sm" onClick={() => onApproveAlways(toolUseId)} className="h-10 bg-amber-400 text-black hover:bg-amber-300">Always Allow</Button>
        <Button size="sm" variant="destructive" onClick={() => onDeny(toolUseId)} className="h-10">Deny</Button>
      </div>
    </div>
  );
}
