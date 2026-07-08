import type { ReferenceRef } from "@shared/references";
import { ReferenceChip } from "./reference-chip";
import { resolveReference } from "./reference-registry";

export type ReferenceSurface = "chat-inline" | "simple-chip" | "simple-row" | "card" | "expanded";

const SURFACE_CLASSES: Record<ReferenceSurface, string | undefined> = {
  "chat-inline": undefined,
  "simple-chip": "text-xs leading-tight",
  "simple-row": "text-xs leading-tight",
  "card": "text-sm leading-tight",
  "expanded": undefined,
};

export function ReferenceRenderer({ refValue, surface = "chat-inline", className }: { refValue: ReferenceRef; surface?: ReferenceSurface; className?: string }) {
  return <ReferenceChip resolved={resolveReference(refValue)} className={[SURFACE_CLASSES[surface], className].filter(Boolean).join(" ")} />;
}
