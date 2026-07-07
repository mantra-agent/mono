import { cn } from "@/lib/utils";
import { ChevronUp, X } from "lucide-react";

interface PreviewChipProps {
  text: string;
  visible: boolean;
  onExpand: () => void;
  onDismiss: () => void;
}

function extractFirstSentence(text: string): string {
  const plain = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();

  const match = plain.match(/^[^.!?\n]+[.!?]?/);
  const sentence = match ? match[0].trim() : plain.slice(0, 120);
  return sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;
}

export function PreviewChip({ text, visible, onExpand, onDismiss }: PreviewChipProps) {
  if (!visible || !text) return null;

  const preview = extractFirstSentence(text);

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 mx-2 mb-1 rounded-lg",
        "bg-muted/60 border border-border/50",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        className="flex-1 min-w-0 text-left text-xs text-foreground/80 truncate hover:text-foreground transition-colors"
      >
        {preview}
      </button>
      <button
        type="button"
        onClick={onExpand}
        className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
        aria-label="Expand response"
      >
        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
        aria-label="Dismiss preview"
      >
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
