import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type NavDotLevel = "error" | "active" | "attention" | "cta" | "pinned" | "unread";

const STATUS_TEXT: Record<NavDotLevel, string> = {
  error: "text-error",
  active: "text-active",
  attention: "text-foreground",
  cta: "text-cta",
  pinned: "text-foreground",
  unread: "text-foreground",
};

/**
 * Returns the icon/text Tailwind classes for the full-color treatment.
 * When a status is present, the parent item's icon and text adopt the status color.
 */
export function getStatusClasses(level: NavDotLevel | null): { icon: string; text: string } {
  if (!level) return { icon: "", text: "" };
  return { icon: STATUS_TEXT[level], text: STATUS_TEXT[level] };
}

/**
 * Returns a Tailwind animation class for the status level.
 * Only active status flashes — all other levels are static.
 */
export function getStatusAnimation(level: NavDotLevel | null): string {
  if (level === "active") return "animate-pulse";
  return "";
}

/**
 * Active/running status icon treatment. The spinner itself rotates while the
 * wrapper owns the flashing active color, matching Build > Design.
 */
export function ActiveStatusSpinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span className="inline-flex shrink-0 text-active animate-pulse">
      <Loader2 className={cn(className, "animate-spin")} />
    </span>
  );
}
