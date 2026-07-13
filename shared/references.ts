export const REFERENCE_TYPES = [
  "page",
  "person",
  "interaction",
  "goal",
  "task",
  "project",
  "milestone",
  "meeting",
  "session",

  "decision",
  "wellness_activity",
  "priority",
  "file",
  "news",
  "web_article",
  "x_item",
  "reddit_post",
  "rss_item",
  "pr",
  "email_thread",
  "email_message",
  "email_draft",
] as const;

export type KnownReferenceType = typeof REFERENCE_TYPES[number];
export type ReferenceType = KnownReferenceType | string;

export interface ReferenceRef {
  type: ReferenceType;
  id: string;
  raw?: string;
  canonical: string;
  legacy?: boolean;
  metadata?: Record<string, unknown>;
}

export type ReferencePart =
  | { kind: "text"; text: string }
  | { kind: "reference"; ref: ReferenceRef };

export interface ReferenceAction {
  id: string;
  label: string;
  type: "navigate" | "mutate" | "copy" | "open_source";
  href?: string;
  payload?: Record<string, unknown>;
}

export interface ResolvedReference {
  ref: ReferenceRef;
  status: "resolved" | "missing" | "unauthorized" | "stale" | "loading" | "error";
  label: string;
  href?: string;
  icon?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  actions?: ReferenceAction[];
}

export function isKnownReferenceType(type: string): type is KnownReferenceType {
  return (REFERENCE_TYPES as readonly string[]).includes(type);
}

export function normalizeReferenceType(type: string): ReferenceType {
  const normalized = type.trim().toLowerCase();
  if (normalized === "spec") return "page";
  if (normalized === "health_activity" || normalized === "wellness") return "wellness_activity";
  if (normalized === "draft") return "email_draft";
  return normalized;
}

export function serializeReference(ref: Pick<ReferenceRef, "type" | "id">): string {
  return `@${normalizeReferenceType(ref.type)}:${ref.id}`;
}

export function createReferenceRef(params: {
  type: string;
  id: string;
  raw?: string;
  legacy?: boolean;
  metadata?: Record<string, unknown>;
}): ReferenceRef {
  const type = normalizeReferenceType(params.type);
  const id = params.id.trim();
  return {
    type,
    id,
    raw: params.raw,
    legacy: params.legacy,
    canonical: serializeReference({ type, id }),
    metadata: params.metadata,
  };
}

export function isParseableReferenceType(type: string): boolean {
  return isKnownReferenceType(normalizeReferenceType(type));
}
