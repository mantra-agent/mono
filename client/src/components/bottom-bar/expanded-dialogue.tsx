import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createPortal } from "react-dom";

interface ExpandedDialogueProps {
  content: string;
  visible: boolean;
  onClose: () => void;
  onOpenInSessions: () => void;
}

export function ExpandedDialogue({
  content,
  visible,
  onClose,
  onOpenInSessions,
}: ExpandedDialogueProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [visible, onClose]);

  if (!visible) return null;

  const dialogue = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex flex-col items-center justify-end"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className={cn(
          "relative w-full max-w-2xl max-h-[70vh] flex flex-col",
          "bg-background border border-border rounded-t-xl shadow-xl",
          "animate-in slide-in-from-bottom-4 duration-200",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-medium">Agent</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="Close expanded dialogue"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap scrollbar-thin">
          {content}
        </div>
        <div className="flex items-center justify-center px-4 py-2 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onOpenInSessions}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            Open in Sessions
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialogue, document.body);
}
