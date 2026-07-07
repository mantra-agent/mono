import type { ReferenceRef } from "@shared/references";
import { ReferenceChip } from "./reference-chip";
import { resolveReference } from "./reference-registry";

export type ReferenceSurface = "chat-inline" | "simple-chip" | "simple-row" | "card" | "expanded";

export function ReferenceRenderer({ refValue, surface = "chat-inline", className }: { refValue: ReferenceRef; surface?: ReferenceSurface; className?: string }) {
  return <ReferenceChip resolved={resolveReference(refValue)} className={className} />;
}
