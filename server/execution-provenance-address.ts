import type { TriggerType } from "@shared/models/chat";
import {
  isParseableReferenceType,
  isValidReferenceIdentifier,
  serializeReference,
} from "@shared/references";
import type { Principal } from "./principal";
import { resolveAddressBatch } from "./address-resolver";

const ARTIFACT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  library_page: "page",
  docx: "file",
};

function metadataString(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function legacyExecutionArtifactAddress(
  refType: string,
  refId: string | null | undefined,
  metadata?: unknown,
): string | null {
  const normalizedType = ARTIFACT_TYPE_ALIASES[refType] || refType;
  let id = refId?.trim() || "";
  if (normalizedType === "page") id = metadataString(metadata, "pageId") || id;
  if (refType === "session_message") {
    const sessionId = metadataString(metadata, "sessionId") || id.split(":", 1)[0];
    return sessionId ? serializeReference({ type: "session", id: sessionId }) : null;
  }
  if (!id || !isParseableReferenceType(normalizedType) || !isValidReferenceIdentifier(normalizedType, id)) return null;
  return serializeReference({ type: normalizedType, id });
}

export async function canonicalExecutionArtifactAddress(
  principal: Principal,
  refType: string,
  refId: string | null | undefined,
  metadata?: unknown,
): Promise<string | null> {
  const legacyAddress = legacyExecutionArtifactAddress(refType, refId, metadata);
  if (!legacyAddress) return null;
  const [result] = await resolveAddressBatch(principal, [legacyAddress]);
  return (result?.outcome === "resolved" || result?.outcome === "redirected") && result.resolution
    ? result.resolution.address
    : null;
}

const TRIGGER_ADDRESS_TYPES: Partial<Record<TriggerType, string>> = {
  intention: "intention",
  timer: "timer",
  hook: "hook",
  skill: "skill",
  plan: "plan",
  meeting: "meeting",
  spawn: "session",
};

export function canonicalSessionTriggerAddress(triggerType: TriggerType | undefined, triggerId: string | undefined): string | undefined {
  if (!triggerType || !triggerId?.trim()) return undefined;
  const addressType = TRIGGER_ADDRESS_TYPES[triggerType];
  const id = triggerId.trim();
  if (!addressType || !isParseableReferenceType(addressType) || !isValidReferenceIdentifier(addressType, id)) return undefined;
  return serializeReference({ type: addressType, id });
}
