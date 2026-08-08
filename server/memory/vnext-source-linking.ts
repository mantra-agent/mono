import { and, eq, sql } from "drizzle-orm";
import { parseReferenceText } from "@shared/reference-parser";
import { memoryVnextSourceLinks } from "@shared/schema";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import { db } from "../db";
import { resolveAddressBatch } from "../address-resolver";
import type { Principal } from "../principal";
import { ownedInsertValues } from "../scoped-storage";
import type { ClaimCandidate } from "./vnext-claim-extraction";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";

export type VnextSourceLinkKind = "explicit_reference" | "inferred_mention";

interface SourceLinkCandidate {
  targetAddress: string;
  kind: VnextSourceLinkKind;
  evidence: string;
  confidence: number;
  provenance: Record<string, unknown>;
}

const sourceLinkScope = {
  scope: memoryVnextSourceLinks.scope,
  ownerUserId: memoryVnextSourceLinks.ownerUserId,
  accountId: memoryVnextSourceLinks.accountId,
};

function boundedEvidence(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 2_000);
}

async function explicitCandidates(content: string, principal: Principal): Promise<SourceLinkCandidate[]> {
  const addresses = [...new Set(parseReferenceText(content)
    .flatMap((part) => part.kind === "reference" ? [part.ref.canonical] : []))]
    .slice(0, 200);
  const candidates: SourceLinkCandidate[] = [];
  for (let offset = 0; offset < addresses.length; offset += 50) {
    const resolved = await resolveAddressBatch(principal, addresses.slice(offset, offset + 50));
    for (const result of resolved) {
      if ((result.outcome !== "resolved" && result.outcome !== "redirected") || !result.resolution) continue;
      const normalized = normalizeProtocolAddress(result.resolution.address);
      if (normalized.outcome !== "valid") continue;
      candidates.push({
        targetAddress: normalized.address,
        kind: "explicit_reference",
        evidence: result.requestedAddress,
        confidence: 1,
        provenance: { method: "canonical_reference_parser", requestedAddress: result.requestedAddress },
      });
    }
  }
  return candidates;
}

async function inferredCandidates(claims: ClaimCandidate[], principal: Principal): Promise<SourceLinkCandidate[]> {
  const candidates: SourceLinkCandidate[] = [];
  for (const claim of claims) {
    const resolutions = await resolveVnextEntityMentions(claim.entityMentions);
    for (const resolution of resolutions) {
      if (resolution.status !== "resolved") continue;
      const requested = `@${resolution.mention.entityType}:${resolution.entityId}`;
      const [authorized] = await resolveAddressBatch(principal, [requested]);
      if (!authorized || (authorized.outcome !== "resolved" && authorized.outcome !== "redirected") || !authorized.resolution) continue;
      const normalized = normalizeProtocolAddress(authorized.resolution.address);
      if (normalized.outcome !== "valid") continue;
      candidates.push({
        targetAddress: normalized.address,
        kind: "inferred_mention",
        evidence: boundedEvidence(claim.evidenceQuote || resolution.mention.name),
        confidence: Math.max(0, Math.min(1, claim.confidence)),
        provenance: {
          method: resolution.matchedBy,
          mention: resolution.mention.name,
          matchedIdentity: resolution.matchedValue,
          claimTitle: claim.title,
        },
      });
    }
  }
  return candidates;
}

/**
 * Replace one exact source revision's semantic link projection. External text and
 * model output are evidence only: every endpoint is independently resolved under
 * the owning principal, ambiguous mentions abstain, and no source object is edited.
 */
export async function replaceVnextSourceLinks(input: {
  principal: Principal;
  sourceType: string;
  sourceId: string;
  sourceRevision: string;
  sourceAddress: string;
  content: string;
  claims: ClaimCandidate[];
  observedAt: Date;
}): Promise<number> {
  const sourceResolution = await resolveAddressBatch(input.principal, [input.sourceAddress]);
  const source = sourceResolution[0];
  if (!source || (source.outcome !== "resolved" && source.outcome !== "redirected") || !source.resolution) return 0;
  const normalizedSource = normalizeProtocolAddress(source.resolution.address);
  if (normalizedSource.outcome !== "valid") return 0;

  const raw = [
    ...await explicitCandidates(input.content, input.principal),
    ...await inferredCandidates(input.claims, input.principal),
  ];
  const deduped = new Map<string, SourceLinkCandidate>();
  for (const candidate of raw) {
    if (candidate.targetAddress === normalizedSource.address) continue;
    const key = `${candidate.kind}:${candidate.targetAddress}`;
    const prior = deduped.get(key);
    if (!prior || candidate.confidence > prior.confidence) deduped.set(key, candidate);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vnext-source-links:${input.sourceType}:${input.sourceId}`}))`);
    await tx.delete(memoryVnextSourceLinks).where(and(
      eq(memoryVnextSourceLinks.ownerUserId, input.principal.userId!),
      eq(memoryVnextSourceLinks.accountId, input.principal.accountId!),
      eq(memoryVnextSourceLinks.sourceType, input.sourceType),
      eq(memoryVnextSourceLinks.sourceId, input.sourceId),
    ));
    const rows = [...deduped.values()].map((candidate) => ({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRevision: input.sourceRevision,
      sourceAddress: normalizedSource.address,
      targetAddress: candidate.targetAddress,
      linkKind: candidate.kind,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
      provenance: candidate.provenance,
      observedAt: input.observedAt,
      ...ownedInsertValues(input.principal, sourceLinkScope),
      createdByUserId: input.principal.userId,
    }));
    if (rows.length > 0) await tx.insert(memoryVnextSourceLinks).values(rows);
    return rows.length;
  });
}
