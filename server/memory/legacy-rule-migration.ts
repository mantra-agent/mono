import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { createNamedSystemPrincipal, type Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { tagRegistry } from "../file-storage/tags";
import { fileRuleStorage } from "../file-storage/rules";
import { documentStoreDocuments, memoryEntries, memoryVnextClaims } from "@shared/schema";
import { getSetting, setSetting } from "../system-settings";
import { memoryVnextClaimStorage, persistClaimCandidates } from "./vnext-claim-storage";

const log = createLogger("LegacyRuleMigration");
const SYSTEM_JOB = "personal-rule-audit-migration";

interface RetainedRuleTemplate {
  id: string;
  rule: string;
  source: "correction";
  scope: "always" | "contextual";
  context: string;
  tags: string[];
}

const RETAINED_RULES: RetainedRuleTemplate[] = [
  {
    id: "mr7bmhm3utqm73",
    rule: "Agent should take the right approach when more than 80% confident, avoiding questions asked only for permission or reassurance. Questions are reserved for genuine forks where a wrong choice would be expensive or hard to reverse.",
    source: "correction",
    scope: "always",
    context: "",
    tags: ["decision-making", "communication", "autonomy"],
  },
  {
    id: "mr7blzb8qgewyd",
    rule: "Never say things like \"I'm not in a rush\" or \"no pressure\" in strategic communications. Stated calm signals anxiety. Convey confidence structurally through tone, brevity, and restraint.",
    source: "correction",
    scope: "contextual",
    context: "strategic communications",
    tags: ["communication", "strategy", "voice", "strategic-communications"],
  },
];

const RETAINED_RULE_IDS = new Set(RETAINED_RULES.map((rule) => rule.id));
const RESTORATION_MARKER_PREFIX = "migration.personal_rules.retained_v2";

const MIGRATED_SOFT_RULE_SOURCE_ID = "mr7bmer6na1gn6";
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

interface RestorationOwner extends AuditedRuleRow {
  promotedRuleCount: number;
}

async function listRestorationOwners(): Promise<RestorationOwner[]> {
  const systemPrincipal = createNamedSystemPrincipal(SYSTEM_JOB);
  return runWithPrincipal(systemPrincipal, async () => {
    const rows = await db
      .select({
        ownerUserId: memoryVnextClaims.ownerUserId,
        accountId: memoryVnextClaims.accountId,
      })
      .from(memoryVnextClaims)
      .where(and(
        eq(memoryVnextClaims.source, "manual"),
        eq(memoryVnextClaims.sourceId, MIGRATED_SOFT_RULE_SOURCE_ID),
        isNotNull(memoryVnextClaims.ownerUserId),
        isNotNull(memoryVnextClaims.accountId),
      ));

    return rows
      .filter((row): row is typeof row & { ownerUserId: string; accountId: string } => (
        !!row.ownerUserId && !!row.accountId
      ))
      .map((row) => ({
        documentId: "retained-rule-restoration",
        ownerUserId: row.ownerUserId,
        accountId: row.accountId,
        vaultId: null,
        promotedRuleCount: 7,
      }));
  });
}

async function restoreMissingRetainedRules(): Promise<{ owners: number; restored: number; errors: number }> {
  const owners = await listRestorationOwners();
  let restored = 0;
  let errors = 0;

  for (const owner of owners) {
    const markerKey = `${RESTORATION_MARKER_PREFIX}.${owner.ownerUserId}`;
    if (await getSetting(markerKey)) continue;

    try {
      const principal = ownerPrincipal(owner);
      await runWithPrincipal(principal, async () => {
        for (const template of RETAINED_RULES) {
          const before = await fileRuleStorage.getById(template.id);
          await fileRuleStorage.restoreFromMigration(template.id, template);
          if (!before) restored++;
        }
      });
      await setSetting(markerKey, {
        completedAt: new Date().toISOString(),
        ownerUserId: owner.ownerUserId,
        accountId: owner.accountId,
        restoredRuleIds: RETAINED_RULES.map((rule) => rule.id),
        promotedRuleCount: owner.promotedRuleCount,
      });
    } catch (error) {
      errors++;
      log.error(
        `retained Rule restoration failed owner=${owner.ownerUserId}: ${error instanceof Error ? error.stack || error.message : String(error)}`,
      );
    }
  }

  if (owners.length > 0 || errors > 0) {
    log.info(`retained Rule restoration owners=${owners.length} restored=${restored} errors=${errors}`);
  }
  return { owners: owners.length, restored, errors };
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

export async function migrateAuditedRules(): Promise<{ scanned: number; retained: number; restored: number; deleted: number; errors: number }> {
  const restoration = await restoreMissingRetainedRules();
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
      retained++;
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
  return {
    scanned: rows.length,
    retained,
    restored: restoration.restored,
    deleted,
    errors: errors + restoration.errors,
  };
}
