import type { SimpleSourceRef } from "./models/simple";
import { createReferenceRef, type ReferenceRef } from "./references";

export function sourceRefToReferenceRef(sourceRef: SimpleSourceRef): ReferenceRef | null {
  switch (sourceRef.type) {
    case "wellness":
      return createReferenceRef({ type: "wellness_activity", id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href } });
    case "task":
    case "project":
    case "milestone":
    case "goal":
    case "decision":
    case "person":
    case "priority":
      return createReferenceRef({ type: sourceRef.type, id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href } });
    case "calendar":
      return createReferenceRef({ type: "meeting", id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href } });
    case "email":
      return createReferenceRef({ type: "email_thread", id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href } });
    case "artifact":
    case "news":
      return createReferenceRef({ type: "file", id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href, sourceType: sourceRef.type } });
    case "agent":
      return createReferenceRef({ type: "file", id: sourceRef.id, metadata: { label: sourceRef.label, href: sourceRef.href } });
    case "comms":
    case "finance":
      return sourceRef.href
        ? createReferenceRef({ type: "file", id: sourceRef.href, metadata: { label: sourceRef.label, sourceType: sourceRef.type } })
        : null;
    default:
      return null;
  }
}

export function sourceRefsToReferenceRefs(sourceRefs: SimpleSourceRef[]): ReferenceRef[] {
  const seen = new Set<string>();
  const refs: ReferenceRef[] = [];
  for (const sourceRef of sourceRefs) {
    const ref = sourceRefToReferenceRef(sourceRef);
    if (!ref || seen.has(ref.canonical)) continue;
    seen.add(ref.canonical);
    refs.push(ref);
  }
  return refs;
}
