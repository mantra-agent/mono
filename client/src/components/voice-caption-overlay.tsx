import { cn } from "@/lib/utils";
import { useVisibilityLayer } from "@/hooks/use-visibility-layer";
import { stripExpressionTags } from "@shared/expression-tags";

interface VoiceCaptionOverlayProps {
  text: string;
  className?: string;
}

/** Quiet, non-interactive projection of the currently audible agent phrase. */
export function VoiceCaptionOverlay({ text, className }: VoiceCaptionOverlayProps) {
  const { layer } = useVisibilityLayer();
  const visibleText = layer === 0 ? stripExpressionTags(text) : text;

  if (!visibleText) return null;

  return (
    <div
      className={cn("pointer-events-none absolute inset-x-4 bottom-8 z-10 flex justify-center", className)}
      aria-live="off"
      data-testid="voice-caption-overlay"
    >
      <p className="max-w-2xl text-balance text-center text-base font-medium leading-relaxed text-foreground drop-shadow-[0_1px_10px_rgba(0,0,0,0.9)] md:text-lg">
        {visibleText}
      </p>
    </div>
  );
}
