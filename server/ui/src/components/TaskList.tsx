import type { ExtractedTask } from "@shared/types";
import { cn } from "@/lib/utils";

interface Props {
  tasks: ExtractedTask[];
}

const statusIcon: Record<ExtractedTask["status"], { icon: string; className: string }> = {
  completed: { icon: "✓", className: "text-emerald-400" },
  in_progress: { icon: "●", className: "text-amber-400 animate-pulse" },
  pending: { icon: "○", className: "text-muted-foreground" },
  deleted: { icon: "○", className: "text-muted-foreground" },
};

export function TaskList({ tasks }: Props) {
  return (
    <div className="py-1.5 space-y-0.5">
      {tasks.map((task) => {
        const { icon, className } = statusIcon[task.status] ?? statusIcon.pending;
        return (
          <div key={task.id} className="flex items-center gap-2 text-xs leading-snug">
            <span className={cn("shrink-0 w-3 text-center", className)}>{icon}</span>
            <span className={cn(
              "truncate",
              task.status === "completed" ? "text-muted-foreground line-through" : "text-foreground",
            )}>
              {task.subject}
            </span>
            {task.status === "in_progress" && task.activeForm && (
              <span className="text-muted-foreground italic truncate ml-auto">{task.activeForm}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
