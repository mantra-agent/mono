import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
} from "../scoped-storage";
import { tagRegistry } from "../file-storage/tags";
import { fileRuleStorage } from "../file-storage/rules";
import {
  documentStoreDocuments,
  memoryEntries,
  type DocumentStoreDocument,
  type MemoryEntry,
} from "@shared/schema";
import { memoryVnextClaimStorage, persistClaimCandidates } from "./vnext-claim-storage";
import type { ClaimCandidate } from "./vnext-claim-extraction";

const log = createLogger("LegacyPreferenceMigration");
const SYSTEM_JOB = "preference-vnext-migration";
const DEFAULT_BATCH_SIZE = 25;

const documentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
};


interface PromotedRule {
  rule: string;
  context: string;
  tags: string[];
}

const PROMOTED_RULES = new Map<string, PromotedRule>([
  ["mrph9zvop6aww3", {
    rule: "In strategic outreach, do not foreground awkward mechanics, delayed replies, obvious realizations, or other negative context that does not advance the relationship. Move directly toward the desired next step.",
    context: "strategic outreach",
    tags: ["communication", "outreach"],
  }],
  ["mrja3mn9zpkjlv", {
    rule: "When proposing meeting times, cluster them near existing calendar commitments to preserve long uninterrupted focus blocks.",
    context: "meeting-time proposals",
    tags: ["calendar", "focus-time"],
  }],
  ["mrc52fij3navf9", {
    rule: "For executive-role positioning, use 'organizational systems' rather than 'operating systems' unless actual operating-system software is meant.",
    context: "executive-role positioning",
    tags: ["career", "terminology"],
  }],
  ["mrc52fijuqhqeo", {
    rule: "When reviewing recruiter or executive-search communications, do not treat urgency framing as a real deadline without independent evidence.",
    context: "recruiter and executive-search communications",
    tags: ["career", "recruiting"],
  }],
  ["mr81lwf1n17ry2", {
    rule: "In voice mode, use short in-between moments to capture and work through ideas rather than deferring them solely because another near-term life task is happening.",
    context: "voice-mode idea capture",
    tags: ["voice", "idea-capture"],
  }],
  ["mr7bnvoh9xxjz0", {
    rule: "Do not default to asking 'what's the one thing?' in coaching conversations. Respond to the substance of what the user is saying.",
    context: "coaching conversations",
    tags: ["coaching", "communication"],
  }],
  ["mr7bnti1l47k04", {
    rule: "Do not ask filler questions. Ask only when the question is genuinely interesting or needed to proceed.",
    context: "conversation",
    tags: ["communication", "questions"],
  }],
]);


const SOFT_CLAIM_CONTENT = new Map<string, string>([
  ["mr7bo0sxibpulv", "Ray prefers short, direct responses for operational and product questions, with more depth only when requested."],
  ["mr7bnpv4bu1zmn", "Ray prefers writing that stays inside the moment rather than announcing or labeling what the reader should feel."],
]);

const SYSTEM_OWNED_PREFERENCE_IDS = new Set([
  "mrkz9z8m72r9nq",
  "mrkxrcfnyui8ni",
  "mr7bo3eeudemzo",
  "mr7bny87rhptn5",
]);

interface LegacyPreference {
  documentId: string;
  ownerUserId: string;
  accountId: string | null;
  vaultId: string | null;
  domain: string;
  preference: string;
  personName: string;
  evidence: string[];
  confidence: number;
  tags: string[];
  createdAt: Date;
  source: "document_store" | "memory_entries";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseMetadata(content: string, metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toLegacyPreference(
  row: DocumentStoreDocument | MemoryEntry,
  source: LegacyPreference["source"],
): LegacyPreference | null {
  if (!row.ownerUserId) {
    log.warn(`skipped orphan preference source=${source} id=${row.id}`);
    return null;
  }
  const metadata = parseMetadata(row.content, row.metadata);
  const preference = String(metadata.preference || "").trim();
  const documentId = source === "document_store"
    ? String((row as DocumentStoreDocument).documentId || "")
    : String((row as MemoryEntry).sourceId || "");
  if (!preference || !documentId) {
    log.warn(`skipped malformed preference source=${source} id=${row.id}`);
    return null;
  }
  const rawConfidence = Number(metadata.confidence ?? 0.5);
  return {
    documentId,
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    vaultId: row.vaultId,
    domain: String(metadata.domain || "personal").trim() || "personal",
    preference,
    personName: String(metadata.personName || "").trim(),
    evidence: stringArray(metadata.evidence),
    confidence: Number.isFinite(rawConfidence) ? Math.max(0.4, Math.min(1, rawConfidence)) : 0.5,
    tags: stringArray(metadata.tags ?? row.tags),
    createdAt: metadata.createdAt ? new Date(String(metadata.createdAt)) : row.createdAt,
    source,
  };
}

function buildOwnerPrincipal(preference: LegacyPreference): Principal {
  return {
    actorType: "user",
    userId: preference.ownerUserId,
    accountId: preference.accountId,
    role: "owner",
    scopes: ["user:read", "user:write"],
    permissions: [],
    isAdmin: false,
    impersonation: {
      impersonatedByActorType: "system",
      reason: "legacy Preference to vNext migration",
    },
    source: "system",
    visibleVaultIds: preference.vaultId ? [preference.vaultId] : [],
    activeVaultId: preference.vaultId,
  };
}

function claimTitle(domain: string): string {
  const words = domain
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return [...words, "Pattern"].slice(0, 3).join(" ") || "Personal Pattern";
}

function toClaim(preference: LegacyPreference): ClaimCandidate {
  const topics = [...new Set([preference.domain.toLowerCase(), ...preference.tags.map((tag) => tag.toLowerCase())])].slice(0, 4);
  return {
    title: claimTitle(preference.domain),
    content: SOFT_CLAIM_CONTENT.get(preference.documentId) ?? preference.preference,
    claimType: "state",
    confidence: preference.confidence,
    topics,
    entityMentions: preference.personName
      ? [{ name: preference.personName, entityType: "person" }]
      : /^Anna\b/.test(preference.preference)
        ? [{ name: "Anna", entityType: "person" }]
        : [],
  };
}

async function deleteLegacyPreference(preference: LegacyPreference, principal: Principal): Promise<void> {
  await tagRegistry.removeEntityTags("preference", preference.documentId);

  await db
    .delete(documentStoreDocuments)
    .where(combineWithWritableScope(
      principal,
      documentScopeColumns,
      and(
        eq(documentStoreDocuments.documentType, "preference"),
        eq(documentStoreDocuments.documentId, preference.documentId),
      ),
    ));

  await db
    .delete(memoryEntries)
    .where(combineWithWritableScope(
      principal,
      memoryScopeColumns,
      and(
        eq(memoryEntries.layer, "workspace"),
        eq(memoryEntries.source, "preference"),
        eq(memoryEntries.sourceId, preference.documentId),
      ),
    ));
}

async function migrateOne(preference: LegacyPreference): Promise<void> {
  const principal = buildOwnerPrincipal(preference);
  await runWithPrincipal(principal, async () => {
    const promotedRule = PROMOTED_RULES.get(preference.documentId);
    if (promotedRule) {
      const existingRules = await fileRuleStorage.getAll();
      if (!existingRules.some((rule) => rule.rule === promotedRule.rule)) {
        await fileRuleStorage.create({
          rule: promotedRule.rule,
          source: "manual",
          scope: "contextual",
          context: promotedRule.context,
          tags: promotedRule.tags,
        });
      }
      await deleteLegacyPreference(preference, principal);
      return;
    }

    if (SYSTEM_OWNED_PREFERENCE_IDS.has(preference.documentId)) {
      await deleteLegacyPreference(preference, principal);
      return;
    }

    const existingClaims = await memoryVnextClaimStorage.findClaimsBySourceOrigin(
      "manual",
      preference.documentId,
    );
    if (existingClaims.length === 0) {
      const result = await persistClaimCandidates({
        claims: [toClaim(preference)],
        source: "manual",
        sourceId: preference.documentId,
        sourceMemoryId: null,
        sourceRefs: [{
          sourceType: "legacy_preference",
          sourceId: preference.documentId,
          relationship: "extracted_from",
          context: `Migrated from retired Preferences domain ${preference.domain}`,
          quote: preference.evidence[0] ?? null,
          strength: 1,
        }],
        createdAt: Number.isNaN(preference.createdAt.getTime()) ? undefined : preference.createdAt,
        metadata: {
          migratedFrom: "preference",
          legacyPreferenceId: preference.documentId,
          legacyDomain: preference.domain,
          legacyPersonName: preference.personName || null,
          legacyEvidence: preference.evidence,
          legacyTags: preference.tags,
        },
        logPrefix: "legacyPreferenceMigration",
      });

      if (result.created + result.reinforced !== 1) {
        throw new Error(`Preference ${preference.documentId} was not durably admitted to vNext`);
      }
    }
    await deleteLegacyPreference(preference, principal);
  });
}

async function listPending(limit: number): Promise<LegacyPreference[]> {
  const systemPrincipal = createNamedSystemPrincipal(SYSTEM_JOB);
  return runWithPrincipal(systemPrincipal, async () => {
    const targetRows = await db
      .select()
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        systemPrincipal,
        documentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "preference"),
          isNotNull(documentStoreDocuments.ownerUserId),
        ),
      ))
      .orderBy(documentStoreDocuments.id)
      .limit(limit);

    const preferences = targetRows
      .map((row) => toLegacyPreference(row, "document_store"))
      .filter((row): row is LegacyPreference => !!row);
    const remaining = limit - preferences.length;
    if (remaining <= 0) return preferences;

    const legacyRows = await db
      .select()
      .from(memoryEntries)
      .where(combineWithVisibleScope(
        systemPrincipal,
        memoryScopeColumns,
        and(
          eq(memoryEntries.layer, "workspace"),
          eq(memoryEntries.source, "preference"),
          isNotNull(memoryEntries.ownerUserId),
          sql`NOT EXISTS (
            SELECT 1 FROM ${documentStoreDocuments} target
            WHERE target.document_type = 'preference'
              AND target.document_id = ${memoryEntries.sourceId}
              AND target.owner_user_id IS NOT DISTINCT FROM ${memoryEntries.ownerUserId}
              AND target.account_id IS NOT DISTINCT FROM ${memoryEntries.accountId}
          )`,
        ),
      ))
      .orderBy(memoryEntries.id)
      .limit(remaining);

    return [
      ...preferences,
      ...legacyRows
        .map((row) => toLegacyPreference(row, "memory_entries"))
        .filter((row): row is LegacyPreference => !!row),
    ];
  });
}

export async function migrateLegacyPreferences(
  limit = DEFAULT_BATCH_SIZE,
): Promise<{ scanned: number; migrated: number; errors: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const pending = await listPending(boundedLimit);
  let migrated = 0;
  let errors = 0;

  for (const preference of pending) {
    try {
      await migrateOne(preference);
      migrated++;
    } catch (error) {
      errors++;
      log.error(
        `migration failed id=${preference.documentId} owner=${preference.ownerUserId}: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      );
    }
  }

  if (pending.length > 0 || errors > 0) {
    log.info(`batch complete scanned=${pending.length} migrated=${migrated} errors=${errors}`);
  }
  return { scanned: pending.length, migrated, errors };
}
