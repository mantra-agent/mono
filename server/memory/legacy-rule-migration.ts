import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { tagRegistry } from "../file-storage/tags";
import { fileRuleStorage } from "../file-storage/rules";
import { documentStoreDocuments, memoryEntries } from "@shared/schema";
import { memoryVnextClaimStorage, persistClaimCandidates } from "./vnext-claim-storage";

const log = createLogger("LegacyRuleMigration");
const SYSTEM_JOB = "personal-rule-audit-migration";

const RETAINED_RULE_IDS = new Set([
  "mr7bmhm3utqm73",
  "mr7blzb8qgewyd",
]);

const SOFT_RULE_CLAIMS = new Map<string, {
  title: string;
  content: string;
  confidence: number;
  topics: string[];
}>([
  ["mr7bmer6na1gn6", {
    title: "Complexity Preference",
    content: "Ray prefers fewer moving parts when choices are uncertain because decision fatigue is costly; complexity should earn its place.",
    confidence: 0.9,
    topics: ["decision-making", "simplicity"],
  }],
]);

const AUDITED_RULE_IDS = [
  "mrpi5c7yuphlkr", "mrohzvboslzj7u", "mro3unvxwncffr", "mrielqub5k5dst",
  "mri1dw3txms0pr", "mrc6b63xz0alt4", "mr7bnlvvt90qmh", "mr7bnjan1a0uyy",
  "mr7bngdxy5mt0r", "mr7bndufg5p66l", "mr7bn9wdmyfmft", "mr7bn7o59n8c4l",
  "mr7bn144hsmc0a", "mr7bmyhvhfosfi", "mr7bmvjos4q64d", "mr7bmsg05xg9dv",
  "mr7bmolnn76emi", "mr7bmm3b3sdeja", "mr7bmkavlwhomc", "mr7bmhm3utqm73",
  "mr7bmer6na1gn6", "mr7bmcwzngetin", "mr7bm67wtjsmbv", "mr7bm578wk8dba",
  "mr7bm46on41g6q", "mr7bm2zszfp18a", "mr7bm1wee6xe7l", "mr7bm0efrm2tez",
  "mr7blzb8qgewyd", "mr7bly8o6z3s6t", "mr7blwrdpjtgx1", "mr7blvp4dws9t2",
];

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

interface AuditedRuleRow {
  documentId: string;
  ownerUserId: string;
  accountId: string | null;
  vaultId: string | null;
}

function ownerPrincipal(row: AuditedRuleRow): Principal {
  return {
    actorType: "user",
    userId: row.ownerUserId,
    accountId: row.accountId,
    role: "owner",
    scopes: ["user:read", "user:write"],
    permissions: [],
    isAdmin: false,
    impersonation: {
      impersonatedByActorType: "system",
      reason: "personal Rule architecture audit migration",
    },
    source: "system",
    visibleVaultIds: row.vaultId ? [row.vaultId] : [],
    activeVaultId: row.vaultId,
  };
}

async function deleteAuditedRule(row: AuditedRuleRow): Promise<void> {
  const principal = ownerPrincipal(row);
  await runWithPrincipal(principal, async () => {
    await tagRegistry.removeEntityTags("rule", row.documentId);
    await db
      .delete(documentStoreDocuments)
      .where(combineWithWritableScope(
        principal,
        documentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "rule"),
          eq(documentStoreDocuments.documentId, row.documentId),
        ),
      ));
    await db
      .delete(memoryEntries)
      .where(combineWithWritableScope(
        principal,
        memoryScopeColumns,
        and(
          eq(memoryEntries.layer, "workspace"),
          eq(memoryEntries.source, "rule"),
          eq(memoryEntries.sourceId, row.documentId),
        ),
      ));
  });
}


async function migrateSoftRule(row: AuditedRuleRow): Promise<void> {
  const claim = SOFT_RULE_CLAIMS.get(row.documentId);
  if (!claim) return;
  const principal = ownerPrincipal(row);
  await runWithPrincipal(principal, async () => {
    const existingClaims = await memoryVnextClaimStorage.findClaimsBySourceOrigin(
      "manual",
      row.documentId,
    );
    if (existingClaims.length === 0) {
      const result = await persistClaimCandidates({
        claims: [{
          title: claim.title,
          content: claim.content,
          claimType: "state",
          confidence: claim.confidence,
          topics: claim.topics,
          entityMentions: [],
        }],
        source: "manual",
        sourceId: row.documentId,
        sourceMemoryId: null,
        sourceRefs: [{
          sourceType: "legacy_rule",
          sourceId: row.documentId,
          relationship: "extracted_from",
          context: "Reclassified from a legacy Rule as a soft personal pattern",
          strength: 1,
        }],
        metadata: {
          migratedFrom: "rule",
          legacyRuleId: row.documentId,
        },
        logPrefix: "legacyRuleMigration",
      });
      if (result.created + result.reinforced !== 1) {
        throw new Error(`Legacy Rule ${row.documentId} was not durably admitted to vNext`);
      }
    }
  });
  await deleteAuditedRule(row);
}

async function listAuditedRules(): Promise<AuditedRuleRow[]> {
  const systemPrincipal = createNamedSystemPrincipal(SYSTEM_JOB);
  return runWithPrincipal(systemPrincipal, async () => {
    const targetRows = await db
      .select({
        documentId: documentStoreDocuments.documentId,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
        vaultId: documentStoreDocuments.vaultId,
      })
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        systemPrincipal,
        documentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "rule"),
          inArray(documentStoreDocuments.documentId, AUDITED_RULE_IDS),
          isNotNull(documentStoreDocuments.ownerUserId),
          sql`(
            ${documentStoreDocuments.metadata} ? 'confidence'
            OR ${documentStoreDocuments.metadata} ? 'reinforcements'
            OR ${documentStoreDocuments.metadata} ? 'violations'
            OR ${documentStoreDocuments.metadata} ? 'principleRef'
          )`,
        ),
      ));

    const targetKeys = new Set(targetRows.map((row) => `${row.ownerUserId}:${row.documentId}`));
    const legacyRows = await db
      .select({
        documentId: memoryEntries.sourceId,
        ownerUserId: memoryEntries.ownerUserId,
        accountId: memoryEntries.accountId,
        vaultId: memoryEntries.vaultId,
      })
      .from(memoryEntries)
      .where(combineWithVisibleScope(
        systemPrincipal,
        memoryScopeColumns,
        and(
          eq(memoryEntries.layer, "workspace"),
          eq(memoryEntries.source, "rule"),
          inArray(memoryEntries.sourceId, AUDITED_RULE_IDS),
          isNotNull(memoryEntries.sourceId),
          isNotNull(memoryEntries.ownerUserId),
          sql`(
            ${memoryEntries.metadata} ? 'confidence'
            OR ${memoryEntries.metadata} ? 'reinforcements'
            OR ${memoryEntries.metadata} ? 'violations'
            OR ${memoryEntries.metadata} ? 'principleRef'
          )`,
        ),
      ));

    return [
      ...targetRows.filter((row): row is AuditedRuleRow => !!row.ownerUserId),
      ...legacyRows
        .filter((row): row is typeof row & { documentId: string; ownerUserId: string } => !!row.documentId && !!row.ownerUserId)
        .filter((row) => !targetKeys.has(`${row.ownerUserId}:${row.documentId}`)),
    ];
  });
}

export async function migrateAuditedRules(): Promise<{ scanned: number; retained: number; deleted: number; errors: number }> {
  const rows = await listAuditedRules();
  let retained = 0;
  let deleted = 0;
  let errors = 0;

  for (const row of rows) {
    if (SOFT_RULE_CLAIMS.has(row.documentId)) {
      try {
        await migrateSoftRule(row);
        deleted++;
      } catch (error) {
        errors++;
        log.error(`failed to migrate soft Rule id=${row.documentId} owner=${row.ownerUserId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
      continue;
    }
    if (RETAINED_RULE_IDS.has(row.documentId)) {
      try {
        const principal = ownerPrincipal(row);
        await runWithPrincipal(principal, async () => {
          const rule = await fileRuleStorage.getById(row.documentId);
          if (!rule) throw new Error(`Retained Rule ${row.documentId} not found`);
          const normalized = await fileRuleStorage.update(row.documentId, { tags: rule.tags });
          if (!normalized) throw new Error(`Retained Rule ${row.documentId} was not writable`);
          await db
            .delete(memoryEntries)
            .where(combineWithWritableScope(
              principal,
              memoryScopeColumns,
              and(
                eq(memoryEntries.layer, "workspace"),
                eq(memoryEntries.source, "rule"),
                eq(memoryEntries.sourceId, row.documentId),
              ),
            ));
        });
        retained++;
      } catch (error) {
        errors++;
        log.error(`failed to normalize retained id=${row.documentId} owner=${row.ownerUserId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      }
      continue;
    }
    try {
      await deleteAuditedRule(row);
      deleted++;
    } catch (error) {
      errors++;
      log.error(`failed id=${row.documentId} owner=${row.ownerUserId}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }

  if (rows.length > 0 || errors > 0) {
    log.info(`audit complete scanned=${rows.length} retained=${retained} deleted=${deleted} errors=${errors}`);
  }
  return { scanned: rows.length, retained, deleted, errors };
}
