import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ExecutionStep } from "@shared/streaming-types";
import { Wrench } from "lucide-react";

interface StatusLineProps {
  step: ExecutionStep | null;
  visible: boolean;
}

function getStepLabel(step: ExecutionStep): string {
  if (step.type === "tool_call") {
    return step.name || "Working…";
  }
  if (step.type === "thinking") {
    return "Thinking…";
  }
  return "Working…";
}

export function StatusLine({ step, visible }: StatusLineProps) {
  const [displayed, setDisplayed] = useState<ExecutionStep | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible && step) {
      setDisplayed(step);
      setShow(true);
    } else {
      setShow(false);
    }
  }, [step, visible]);

  if (!show || !displayed) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground",
        "transition-opacity duration-300",
        show ? "opacity-100" : "opacity-0",
      )}
    >
      {displayed.type === "tool_call" && (
        <Wrench className="h-3 w-3 shrink-0 animate-spin" />
      )}
      {displayed.type === "thinking" && (
        <span className="h-3 w-3 shrink-0 rounded-full bg-muted-foreground/40 animate-pulse" />
      )}
      <span className="truncate">{getStepLabel(displayed)}</span>
    </div>
  );
}
