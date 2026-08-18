import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "./log";
import { db } from "./db";
import { getPostgresErrorDetails } from "./postgres-errors";
import {
  skills,
  skillReferences,
  skillRevisions,
  libraryPages,
  personas,
  skillPersonaPreferences,
} from "@shared/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { BUILTIN_SKILL_DEFAULTS } from "./skill-defaults";
import * as fs from "fs";
import * as path from "path";
import {
  CANONICAL_AFFIRM_SKILL_ID,
  CANONICAL_DAILY_BRIEF_SKILL_ID,
  CANONICAL_REGRESSION_SKILL_ID,
  CANONICAL_SCAN_SKILL_ID,
  SKILL_NAME_ALIASES,
} from "./skill-identities";

const log = createLogger("SkillSeed");

/** Skill lattice payload — hash identity/protocol/run-shape/references only. */
export interface SkillRevisionPayload {
  name: string;
  description: string;
  category: string;
  whenToUse: string;
  process: string;
  outputSpec: string;
  checklist: unknown;
  scoreThreshold: number | null;
  sessionType: string | null;
  activity: string;
  recommendedPersonaTemplateId: number | null;
  addToMemory: boolean;
  pinnedToContext: boolean;
  references: Array<{ name: string; content: string }>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function skillPayloadHash(payload: SkillRevisionPayload): string {
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

/** Canonical skill payload field order — the merge/diff surface (Persona REVISION_FIELDS mirror). */
export const SKILL_PAYLOAD_FIELDS: (keyof SkillRevisionPayload)[] = [
  "name",
  "description",
  "category",
  "whenToUse",
  "process",
  "outputSpec",
  "checklist",
  "scoreThreshold",
  "sessionType",
  "activity",
  "recommendedPersonaTemplateId",
  "addToMemory",
  "pinnedToContext",
  "references",
];

/** Named changed fields between two skill payloads — whole-field compare, never AI merge. */
export function changedSkillFields(
  from: SkillRevisionPayload,
  to: SkillRevisionPayload,
): string[] {
  return SKILL_PAYLOAD_FIELDS.filter(
    (field) =>
      JSON.stringify(stableValue(from[field])) !==
      JSON.stringify(stableValue(to[field])),
  ) as string[];
}

/**
 * Structural source for a revision payload. Full skill rows and enriched
 * `SkillWithReferences` (which omits `allowedTools`) both satisfy it, so read
 * enrichment can compute a payload without casting through the full row type.
 */
export type SkillRevisionSource = Pick<
  typeof skills.$inferSelect,
  | "name"
  | "description"
  | "category"
  | "whenToUse"
  | "process"
  | "outputSpec"
  | "checklist"
  | "scoreThreshold"
  | "sessionType"
  | "activity"
  | "recommendedPersonaTemplateId"
  | "addToMemory"
  | "pinnedToContext"
>;

export function skillRevisionPayload(
  row: SkillRevisionSource,
  references: Array<{ name: string; content: string }>,
): SkillRevisionPayload {
  const sortedRefs = [...references]
    .map((ref) => ({ name: ref.name, content: ref.content }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.content.localeCompare(b.content));
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    whenToUse: row.whenToUse,
    process: row.process,
    outputSpec: row.outputSpec,
    checklist: row.checklist ?? [],
    scoreThreshold: row.scoreThreshold ?? null,
    sessionType: row.sessionType ?? null,
    activity: row.activity,
    recommendedPersonaTemplateId: row.recommendedPersonaTemplateId ?? null,
    addToMemory: row.addToMemory,
    pinnedToContext: row.pinnedToContext,
    references: sortedRefs,
  };
}

/** One code catalog entry projected onto the lattice payload merge surface. */
export interface CodeCatalogSkillInput {
  name: string;
  version: string;
  input: Partial<SkillRevisionPayload>;
}

/**
 * Project BUILTIN_SKILL_DEFAULTS (the SEED_PERSONAS mirror) onto the lattice
 * payload input. References and recommendedPersonaTemplateId are intentionally
 * omitted so the catalog publisher's whole-field overlay preserves each global's
 * current references and persona recommendation (owned by separate seed paths).
 */
export function codeCatalogSkillInputs(): CodeCatalogSkillInput[] {
  return BUILTIN_SKILL_DEFAULTS.map((def) => ({
    name: def.name,
    version: def.version || "1.0",
    input: {
      name: def.name,
      description: def.description,
      category: def.category,
      whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
      process: def.process,
      outputSpec: def.outputSpec ?? "See process instructions",
      checklist: def.checklist ?? [],
      scoreThreshold: def.scoreThreshold ?? null,
      sessionType: def.sessionType ?? null,
      activity: def.activity,
      addToMemory: def.addToMemory ?? true,
      pinnedToContext: def.pinnedToContext ?? false,
    },
  }));
}

/**
 * Skill Default Lattice cut 1 — additive snapshot + classification only.
 * Every pre-lattice Skill gets an immutable revision of its current payload.
 * User shadows link to same-name globals. Leftover is exact-hash only and is
 * classified, never rebased. Mixed/unprovable rows stay customized or pinned_legacy.
 * customized remains the freeze flag; no publish, no runtime resolution change.
 */
export async function initializeSkillRevisionLineage(): Promise<void> {
  let snapshotted = 0;
  let linked = 0;
  let classifiedFollowing = 0;
  let classifiedCustomized = 0;
  let classifiedPinnedLegacy = 0;
  let classifiedLeftover = 0;
  let abstained = 0;
  // Rows that newly enter the lattice this boot. Classification only writes
  // these (plus rows still at the unclassified `pinned_legacy` default), so a
  // later boot never clobbers a `following`/`customized`/`update_available`
  // state owned by the catalog publisher, leftover heal, or a user mutation.
  const snapshottedIds = new Set<string>();

  await db.transaction(async (tx) => {
    const allSkills = await tx.select().from(skills);
    const allRefs = await tx.select().from(skillReferences);
    const refsBySkill = new Map<string, Array<{ name: string; content: string }>>();
    for (const ref of allRefs) {
      const list = refsBySkill.get(ref.skillId) ?? [];
      list.push({ name: ref.name, content: ref.content });
      refsBySkill.set(ref.skillId, list);
    }

    const payloadBySkillId = new Map<string, SkillRevisionPayload>();
    const hashBySkillId = new Map<string, string>();
    for (const row of allSkills) {
      const payload = skillRevisionPayload(row, refsBySkill.get(row.id) ?? []);
      payloadBySkillId.set(row.id, payload);
      hashBySkillId.set(row.id, skillPayloadHash(payload));
    }

    // 1) Snapshot every Skill missing a current revision — immutable recoverability.
    for (const row of allSkills) {
      if (row.currentRevisionId) {
        abstained++;
        continue;
      }
      const payload = payloadBySkillId.get(row.id)!;
      const contentHash = hashBySkillId.get(row.id)!;
      const revisionScope = row.scope === "global" ? "platform" : "user";
      if (revisionScope === "user" && (!row.ownerUserId || !row.accountId)) {
        // Unowned user-scope row cannot satisfy skill_revisions CHECK; pin only.
        await tx
          .update(skills)
          .set({ updateState: "pinned_legacy", updatedAt: new Date() })
          .where(eq(skills.id, row.id));
        classifiedPinnedLegacy++;
        continue;
      }
      const revisionId = randomUUID();
      await tx.insert(skillRevisions).values({
        id: revisionId,
        skillIdentityId: row.id,
        scope: revisionScope,
        ownerUserId: revisionScope === "user" ? row.ownerUserId : null,
        accountId: revisionScope === "user" ? row.accountId : null,
        instanceId: revisionScope === "user" ? row.instanceId ?? null : null,
        parentRevisionId: null,
        platformBaseRevisionId: null,
        payload,
        contentHash,
        changeSummary: "Initial skill lattice snapshot",
        createdByUserId: null,
      });
      await tx
        .update(skills)
        .set({
          baseRevisionId: revisionId,
          currentRevisionId: revisionId,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, row.id));
      row.baseRevisionId = revisionId;
      row.currentRevisionId = revisionId;
      snapshottedIds.add(row.id);
      snapshotted++;
    }

    // Reload after snapshots so classification sees revision ids.
    const skillsAfter = await tx.select().from(skills);
    const revisions = await tx.select().from(skillRevisions);
    const platformHashesByIdentity = new Map<string, Set<string>>();
    for (const rev of revisions) {
      if (rev.scope !== "platform") continue;
      const set = platformHashesByIdentity.get(rev.skillIdentityId) ?? new Set();
      set.add(rev.contentHash);
      platformHashesByIdentity.set(rev.skillIdentityId, set);
    }

    const globalByName = new Map<string, (typeof skillsAfter)[number]>();
    for (const row of skillsAfter) {
      if (row.scope === "global") {
        globalByName.set(row.name.toLowerCase(), row);
      }
    }

    // 2) Link user shadows to same-name global template.
    for (const row of skillsAfter) {
      if (row.scope !== "user" || row.templateSkillId) continue;
      const template = globalByName.get(row.name.toLowerCase());
      if (!template) continue;
      await tx
        .update(skills)
        .set({ templateSkillId: template.id, updatedAt: new Date() })
        .where(eq(skills.id, row.id));
      row.templateSkillId = template.id;
      linked++;
    }

    // 3) Classify updateState only — never rebase or rewrite payload.
    //    Idempotent: only classify rows new to the lattice this boot, or rows
    //    still at the unclassified `pinned_legacy` default. Rows already moved to
    //    following/customized/update_available/conflict are owned by the catalog
    //    publisher, leftover heal, and user mutations — do not re-derive them.
    for (const row of skillsAfter) {
      if (!snapshottedIds.has(row.id) && row.updateState !== "pinned_legacy") continue;
      const hash = hashBySkillId.get(row.id) ?? skillPayloadHash(
        skillRevisionPayload(row, refsBySkill.get(row.id) ?? []),
      );

      if (row.scope === "global") {
        if (row.author === "system" && row.customized !== true) {
          await tx
            .update(skills)
            .set({ updateState: "following", updatedAt: new Date() })
            .where(eq(skills.id, row.id));
          classifiedFollowing++;
          continue;
        }
        // customized global: leftover only on exact historical platform hash
        // of this identity that is not the sole current snapshot (needs prior).
        const historical = platformHashesByIdentity.get(row.id);
        const currentRev = row.currentRevisionId
          ? revisions.find((r) => r.id === row.currentRevisionId)
          : undefined;
        const hasOlderExact =
          !!historical &&
          historical.size > 1 &&
          historical.has(hash) &&
          currentRev?.contentHash === hash;
        // First lattice boot has only one revision per skill — cannot prove
        // older seed. Mixed/customized globals stay customized (Keep-mine).
        // Leftover proof requires a second distinct historical platform hash.
        if (hasOlderExact && historical && [...historical].some((h) => h !== hash)) {
          // Exact older platform payload still present — leftover candidate.
          // Cut 1 classifies only; heal/rebase is a later cut.
          await tx
            .update(skills)
            .set({ updateState: "pinned_legacy", updatedAt: new Date() })
            .where(eq(skills.id, row.id));
          classifiedLeftover++;
          continue;
        }
        if (row.customized === true) {
          await tx
            .update(skills)
            .set({ updateState: "customized", updatedAt: new Date() })
            .where(eq(skills.id, row.id));
          classifiedCustomized++;
          continue;
        }
        await tx
          .update(skills)
          .set({ updateState: "pinned_legacy", updatedAt: new Date() })
          .where(eq(skills.id, row.id));
        classifiedPinnedLegacy++;
        continue;
      }

      // User-scoped shadows
      if (row.templateSkillId) {
        const template = skillsAfter.find((s) => s.id === row.templateSkillId);
        const templateHash = template ? hashBySkillId.get(template.id) : undefined;
        const templatePlatformHashes = platformHashesByIdentity.get(row.templateSkillId);
        const userRevisions = revisions.filter(
          (r) => r.skillIdentityId === row.id && r.scope === "user",
        );
        // "No user revision" means only the lattice snapshot exists and content
        // still matches a known platform hash of the template (exact leftover).
        const matchesTemplateCurrent = templateHash != null && hash === templateHash;
        const matchesHistoricalPlatform =
          !!templatePlatformHashes && templatePlatformHashes.has(hash);
        if (matchesTemplateCurrent) {
          const baseId = template?.currentRevisionId ?? row.baseRevisionId;
          await tx
            .update(skills)
            .set({
              updateState: "following",
              baseRevisionId: baseId,
              // Keep own snapshot as currentRevisionId for recoverability; base
              // points at the platform revision the copy follows.
              updatedAt: new Date(),
            })
            .where(eq(skills.id, row.id));
          classifiedFollowing++;
          continue;
        }
        if (
          matchesHistoricalPlatform &&
          userRevisions.length <= 1 &&
          !matchesTemplateCurrent
        ) {
          // Exact older platform hash, no authored user revision beyond snapshot.
          await tx
            .update(skills)
            .set({ updateState: "pinned_legacy", updatedAt: new Date() })
            .where(eq(skills.id, row.id));
          classifiedLeftover++;
          continue;
        }
        // Divergent content — Keep-mine / customized.
        await tx
          .update(skills)
          .set({ updateState: "customized", updatedAt: new Date() })
          .where(eq(skills.id, row.id));
        classifiedCustomized++;
        continue;
      }

      // Orphan user skill with no same-name global.
      await tx
        .update(skills)
        .set({ updateState: row.customized ? "customized" : "pinned_legacy", updatedAt: new Date() })
        .where(eq(skills.id, row.id));
      if (row.customized) classifiedCustomized++;
      else classifiedPinnedLegacy++;
    }
  });

  log.info("Skill revision lineage initialized", {
    snapshotted,
    linked,
    classifiedFollowing,
    classifiedCustomized,
    classifiedPinnedLegacy,
    classifiedLeftover,
    abstained,
  });
}

const PROMPT_NAME_TO_SKILL: Record<string, string> = {
  "introspect": "reflect",
  "monthly-reflect": "reflect",
};

/** Seed rename map — derived from shared skill-identities SSOT. */
const SKILL_RENAMES: Record<string, string> = { ...SKILL_NAME_ALIASES };

export async function migrateSkillRenames(): Promise<void> {
  for (const [oldName, newName] of Object.entries(SKILL_RENAMES)) {
    const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, oldName)));
    if (existing) {
      const [conflict] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, newName)));
      if (conflict) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted old skill "${oldName}" (conflict with already-existing "${newName}")`);
      } else {
        await db.update(skills).set({ name: newName, updatedAt: new Date() }).where(eq(skills.id, existing.id));
        log.debug(`Renamed skill "${oldName}" → "${newName}"`);
      }
    }
  }
}

const ADDITIONAL_SKILL_RECOMMENDATIONS: Record<string, string> = {
  "affirm": "Companion",
  "coach": "Coach",
  "curate": "Investigator",
  "research": "Investigator",
};

/**
 * Product defaults for the cognitive stance each skill should use. Built-in
 * defaults live beside their workflow definitions; user-created-but-product-
 * recognized skills are listed above. This migration is replay-safe and only
 * fills empty recommendations, preserving explicit future product changes.
 */
export async function seedSkillPersonaRecommendations(): Promise<void> {
  const recommendations = new Map<string, string>([
    ...BUILTIN_SKILL_DEFAULTS.flatMap((def) =>
      def.recommendedPersona ? [[def.name, def.recommendedPersona] as const] : [],
    ),
    ...Object.entries(ADDITIONAL_SKILL_RECOMMENDATIONS),
  ]);
  const personaNames = [...new Set(recommendations.values())];
  const templates = await db
    .select({ id: personas.id, name: personas.name })
    .from(personas)
    .where(
      and(
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        eq(personas.isSystem, false),
        inArray(personas.name, personaNames),
      ),
    );
  const templateIds = new Map(templates.map((row) => [row.name, row.id]));

  // Creative → Visionary recast: draft was never finished-encounter work.
  // Clear leftover Creative/Visionary recommendations so the skill runs under Root.
  const legacyVisionaryTemplates = await db
    .select({ id: personas.id })
    .from(personas)
    .where(
      and(
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        eq(personas.isSystem, false),
        sql`LOWER(${personas.name}) IN ('visionary', 'creative')`,
      ),
    );
  if (legacyVisionaryTemplates.length > 0) {
    const legacyIds = legacyVisionaryTemplates.map((row) => row.id);
    await db
      .update(skills)
      .set({
        recommendedPersonaTemplateId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(skills.scope, "global"),
          eq(skills.name, "draft"),
          inArray(skills.recommendedPersonaTemplateId, legacyIds),
        ),
      );
  }

  // Operator → Executive recast: maintenance and known-path skills are not
  // allocate-and-commit work. Clear leftover Operator/Executive and Default
  // recommendations so those skills run under Root.
  const maintenanceSkillNames = [
    "history-rollup",
    "brief-daily",
    "autonomy",
    "enrich-email",
    "sleep",
    "goal-manager",
    "streamline",
    "scan",
    "draft",
  ] as const;
  const leftoverTemplates = await db
    .select({ id: personas.id })
    .from(personas)
    .where(
      and(
        eq(personas.scope, "global"),
        eq(personas.source, "seed"),
        eq(personas.isSystem, false),
        sql`LOWER(${personas.name}) IN ('executive', 'operator', 'default')`,
      ),
    );
  if (leftoverTemplates.length > 0) {
    const leftoverIds = leftoverTemplates.map((row) => row.id);
    await db
      .update(skills)
      .set({
        recommendedPersonaTemplateId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(skills.scope, "global"),
          inArray(skills.name, [...maintenanceSkillNames]),
          inArray(skills.recommendedPersonaTemplateId, leftoverIds),
        ),
      );
  }

  let applied = 0;
  for (const [skillName, personaName] of recommendations) {
    const templateId = templateIds.get(personaName);
    if (!templateId) {
      log.error(`Cannot seed persona recommendation for skill "${skillName}": global template "${personaName}" is missing`);
      continue;
    }
    const updated = await db
      .update(skills)
      .set({ recommendedPersonaTemplateId: templateId, updatedAt: new Date() })
      .where(
        and(
          eq(skills.scope, "global"),
          eq(skills.name, skillName),
          sql`${skills.recommendedPersonaTemplateId} IS NULL`,
        ),
      )
      .returning({ id: skills.id });
    applied += updated.length;
  }
  log.debug(`Skill persona recommendations complete: ${applied} newly applied, ${recommendations.size} configured`);
}

/**
 * Migrate legacy skills.persona_id values into user-owned preferences using
 * the skill row's existing owner/account identity. No user identity is guessed.
 * The legacy column is cleared only after the preference upsert succeeds.
 */
export async function migrateLegacySkillPersonaPreferences(): Promise<void> {
  const legacy = await db
    .select({
      id: skills.id,
      personaId: skills.personaId,
      ownerUserId: skills.ownerUserId,
      accountId: skills.accountId,
    })
    .from(skills)
    .where(isNotNull(skills.personaId));

  let migrated = 0;
  for (const row of legacy) {
    if (!row.personaId || !row.ownerUserId || !row.accountId) {
      log.error(`Cannot migrate legacy skill persona for skill=${row.id}: missing owner/account identity`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(skillPersonaPreferences)
        .values({
          skillId: row.id,
          personaId: row.personaId!,
          ownerUserId: row.ownerUserId!,
          accountId: row.accountId!,
        })
        .onConflictDoUpdate({
          target: [
            skillPersonaPreferences.skillId,
            skillPersonaPreferences.ownerUserId,
            skillPersonaPreferences.accountId,
          ],
          set: {
            personaId: row.personaId!,
            accountId: row.accountId!,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(skills)
        .set({ personaId: null, updatedAt: new Date() })
        .where(eq(skills.id, row.id));
    });
    migrated++;
  }
  if (migrated > 0) {
    log.debug(`Migrated ${migrated} legacy skill persona assignments into user preferences`);
  }
}

const CANONICAL_BUILTIN_SKILL_IDS: Readonly<Record<string, string>> = {
  affirm: CANONICAL_AFFIRM_SKILL_ID,
  "brief-daily": CANONICAL_DAILY_BRIEF_SKILL_ID,
  regression: CANONICAL_REGRESSION_SKILL_ID,
};

/**
 * Compare dotted skill versions. Exported for the Skill Default Lattice catalog
 * publisher (server/storage.ts) so version-gated advancement lives in one place.
 */
export function compareSkillVersions(left: string, right: string): number | null {
  const parse = (value: string): number[] | null => {
    const core = value.trim().split("-")[0];
    if (!/^\d+(?:\.\d+)*$/.test(core)) return null;
    return core.split(".").map((part) => Number(part));
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

// Retired in Skill Default Lattice cut 3: the customized Plan (1.1→1.2) and
// Daily Brief (7.7→7.9) clause merges are superseded by the code-catalog lattice
// publisher (HybridStorage.syncSkillCatalogToLattice). A code default now offers
// itself inbound to a customized global instead of a fingerprinted in-place patch.

export async function seedBuiltinSkills(): Promise<void> {
  let inserted = 0;
  let preserved = 0;
  let errored = 0;

  for (const def of BUILTIN_SKILL_DEFAULTS) {
    try {
      const defVersion = def.version || "1.0";

      if (def.name === "autonomy") {
        const [blankAutonomy] = await db
          .select({ id: skills.id, description: skills.description })
          .from(skills)
          .where(and(eq(skills.scope, "global"), eq(skills.name, "")));
        if (blankAutonomy?.description?.includes("autonomous scan-and-execute loop")) {
          await db.update(skills).set({
            name: def.name,
            description: def.description,
            category: def.category,
            activity: def.activity,
            process: def.process,
            checklist: def.checklist || [],
            whenToUse: def.whenToUse || "",
            outputSpec: def.outputSpec || "",
            version: defVersion,
            author: def.author || "system",
            addToMemory: def.addToMemory ?? true,
            pinnedToContext: def.pinnedToContext ?? false,
            updatedAt: new Date(),
          }).where(eq(skills.id, blankAutonomy.id));
          log.debug(`Renamed blank-name autonomy skill id=${blankAutonomy.id} to "autonomy"`);
          preserved++;
          continue;
        }
      }

      const canonicalId = CANONICAL_BUILTIN_SKILL_IDS[def.name];
      let [existing] = await db
        .select({
          id: skills.id,
          name: skills.name,
          scope: skills.scope,
          author: skills.author,
          customized: skills.customized,
          version: skills.version,
        })
        .from(skills)
        .where(
          canonicalId
            ? or(
                and(eq(skills.scope, "global"), eq(skills.name, def.name)),
                eq(skills.id, canonicalId),
              )
            : and(eq(skills.scope, "global"), eq(skills.name, def.name)),
        );

      if (existing && (existing.scope !== "global" || existing.name !== def.name)) {
        log.warn(
          `Skipped builtin skill "${def.name}": canonical id ${canonicalId} is occupied by ${existing.scope} skill "${existing.name}"`,
        );
        errored++;
        continue;
      }

      if (existing) {
        // Insert-only. Advancing an existing global is no longer an in-place
        // fingerprinted patch that silently breaks on `customized` — that wall
        // is retired. The Skill Default Lattice catalog publisher
        // (HybridStorage.syncSkillCatalogToLattice) mints a platform revision
        // for a code version bump and publishes it through follower rules:
        // `following` globals advance, a mixed customized global is offered the
        // inbound default (update_available) and never overwritten.
        preserved++;
        continue;
      }

      // Supply a complete canonical row for every NOT NULL column rather than
      // relying on database column defaults. Deployed databases restored from a
      // baseline can preserve NOT NULL while losing declared SQL defaults, which
      // makes any `default`-keyword insert fail with 23502. Explicit values keep
      // built-in seeding independent of that drift, matching the createSkill path.
      await db.insert(skills).values({
        ...(CANONICAL_BUILTIN_SKILL_IDS[def.name] ? { id: CANONICAL_BUILTIN_SKILL_IDS[def.name] } : {}),
        name: def.name,
        description: def.description,
        category: def.category,
        activity: def.activity,
        authority: "full",
        writeCategory: "read-only",
        allowedTools: [],
        inputs: [],
        estimatedTokens: 0,
        estimatedDuration: "5min",
        process: def.process,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        qualityCriteria: "",
        checklist: def.checklist ?? [],
        scoreThreshold: def.scoreThreshold ?? null,
        status: "active",
        author: def.author || "system",
        version: defVersion,
        addToMemory: def.addToMemory ?? true,
        budgetBehavior: null,
        pinnedToContext: def.pinnedToContext ?? false,
        sessionType: def.sessionType ?? null,
        customized: false,
        scope: "global",
        successCount: 0,
        failureCount: 0,
      });
      inserted++;
    } catch (error: unknown) {
      const details = getPostgresErrorDetails(error);
      if (details.code === "23505") {
        const canonicalId = CANONICAL_BUILTIN_SKILL_IDS[def.name];
        const [converged] = await db
          .select({ id: skills.id })
          .from(skills)
          .where(
            canonicalId
              ? and(eq(skills.scope, "global"), eq(skills.name, def.name), eq(skills.id, canonicalId))
              : and(eq(skills.scope, "global"), eq(skills.name, def.name)),
          );
        if (converged) {
          preserved++;
        } else {
          errored++;
          log.error("Failed to bootstrap builtin skill: uniqueness conflict did not converge to the canonical global template", {
            skillName: def.name,
            sqlState: details.code,
          });
        }
      } else {
        errored++;
        log.error("Failed to bootstrap builtin skill", {
          skillName: def.name,
          sqlState: details.code,
          errorType: details.errorType,
          causeDepth: details.causeDepth,
        });
      }
    }
  }

  log.info(`Skill bootstrap complete: ${inserted} inserted, ${preserved} existing-preserved, ${errored} errors (total defaults: ${BUILTIN_SKILL_DEFAULTS.length})`);
}

export async function migrateLegacyPromptOverrides(): Promise<void> {
  let overrides: Record<string, string> | null = null;

  const overridesPath = path.join(process.cwd(), "config", "prompts.json");
  if (fs.existsSync(overridesPath)) {
    try {
      overrides = JSON.parse(fs.readFileSync(overridesPath, "utf-8"));
      log.debug(`Found legacy prompt overrides file at ${overridesPath}`);
    } catch { /* ignore parse errors */ }
  }

  if (!overrides) {
    try {
      const { DocumentStorage } = await import("./memory/document-storage");
      const docStore = new DocumentStorage();
      const doc = await docStore.getDocument("prompt_overrides", "all");
      if (doc?.content && typeof doc.content === "object" && Object.keys(doc.content).length > 0) {
        overrides = doc.content as Record<string, string>;
        log.debug(`Found legacy prompt overrides in document storage (${Object.keys(overrides).length} entries)`);
      }
    } catch { /* no doc storage entry */ }
  }

  if (!overrides || Object.keys(overrides).length === 0) return;

  let applied = 0;
  for (const [promptName, overrideText] of Object.entries(overrides)) {
    const skillName = PROMPT_NAME_TO_SKILL[promptName] || promptName.replace(/:/g, "-").toLowerCase();
    const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, skillName)));
    if (existing && typeof overrideText === "string" && overrideText.trim()) {
      await db.update(skills).set({ process: overrideText, updatedAt: new Date() }).where(eq(skills.id, existing.id));
      applied++;
    }
  }

  if (applied > 0) {
    log.debug(`Applied ${applied} legacy prompt overrides to skill records`);
  }

  if (fs.existsSync(overridesPath)) {
    try {
      fs.renameSync(overridesPath, overridesPath + ".migrated");
      log.debug(`Renamed legacy overrides file to ${overridesPath}.migrated`);
    } catch { /* ignore */ }
  }

  try {
    const { DocumentStorage } = await import("./memory/document-storage");
    const docStore = new DocumentStorage();
    await docStore.deleteDocument("prompt_overrides", "all");
    log.debug(`Removed legacy prompt_overrides document`);
  } catch { /* already gone */ }
}

export async function verifyRequiredSkills(): Promise<void> {
  const rows = await db.select({ name: skills.name }).from(skills).where(eq(skills.scope, "global"));
  const existing = new Set(rows.map(r => r.name));
  const required = BUILTIN_SKILL_DEFAULTS.map(d => d.name);
  const missing = required.filter(n => !existing.has(n));
  if (missing.length > 0) {
    log.error(`Missing required skills (${missing.length}): ${missing.join(", ")}`);
  } else {
    log.debug(`All ${required.length} required skills verified`);
  }
}

export async function migrateCanonicalScanToolGate(): Promise<void> {
  const [existing] = await db
    .select({
      id: skills.id,
      version: skills.version,
      process: skills.process,
      checklist: skills.checklist,
    })
    .from(skills)
    .where(and(eq(skills.id, CANONICAL_SCAN_SKILL_ID), eq(skills.name, "scan")));
  if (!existing || compareSkillVersions(existing.version, "1.2") !== -1) return;
  if (!existing.process.includes('Call `news(action: "scan")` immediately.')) {
    log.warn(`Skipped canonical scan tool-gate migration from ${existing.version}: expected news.scan contract was not found`);
    return;
  }
  const checklist = Array.isArray(existing.checklist) ? [...existing.checklist] as Array<Record<string, unknown>> : [];
  const requiredCheck = "Calls news.scan without an independent scan-run preflight";
  const requiredIndex = checklist.findIndex((item) => item?.check === requiredCheck);
  if (requiredIndex < 0) {
    log.warn(`Skipped canonical scan tool-gate migration from ${existing.version}: expected checklist item was not found`);
    return;
  }
  checklist[requiredIndex] = {
    ...checklist[requiredIndex],
    kind: "tool_invoked",
    tool: "news",
    action: "scan",
  };
  const updated = await db
    .update(skills)
    .set({ checklist, version: "1.2", updatedAt: new Date() })
    .where(and(eq(skills.id, existing.id), eq(skills.version, existing.version)))
    .returning({ id: skills.id });
  if (updated.length > 0) {
    log.info(`Migrated canonical scan skill ${existing.version} → 1.2 with deterministic news.scan terminal gate`);
  }
}

export async function deprecateRetiredBuiltinSkills(): Promise<void> {
  // Preserve compatibility rows through the rollback window, but make them inert.
  const retired = ["consolidate", "integrate"];
  for (const name of retired) {
    const [existing] = await db.select({ id: skills.id, author: skills.author, status: skills.status }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
    if (existing && existing.author === "system" && existing.status !== "deprecated") {
      await db.update(skills).set({ status: "deprecated", addToMemory: false, updatedAt: new Date() }).where(eq(skills.id, existing.id));
      log.info(`Deprecated retired builtin skill "${name}"`);
    }
  }
}

// Retired in Skill Default Lattice cut 3: the autonomy meeting-prep (1.5→1.6),
// autonomy provenance (1.6→1.7), and Daily Brief meeting-prep (→7.7) clause
// patches are superseded by the code catalog + lattice publisher. The canonical
// meeting-readiness and session-ledger sections now live in the autonomy code
// default (server/skill-defaults.ts, v1.7); the lattice offers them inbound to a
// customized autonomy seat instead of a fingerprinted in-place patch.

const SENTRY_CHANGESET_GATE_VERSION = "1.10";
const SENTRY_REQUIRED_SENSORS_VERSION = "1.12";
const SENTRY_RUN_EVIDENCE_MARKER = "8. Inspect recent `sentry` skill runs and open system issues/tasks/sessions when useful. Deduplicate by normalized signature + environment + likely subsystem. Update or reference an existing incident instead of creating another.";
const SENTRY_REPORT_MARKER = "## Canonical report page";
const SENTRY_REQUIRED_SENSORS_MARKER = "## Required sensors (hard — first actions)";
const SENTRY_RUN_WINDOW_MARKER = "## Run window and evidence";
const SENTRY_RELIABILITY_OUTCOMES_MARKER = "11. Inspect `system.reliability` for bounded recent windows and explicitly evaluate the canonical success/failure outcomes for tool executions, plan steps, workflow runs, and conversational turns. Split failures into ambers (classified: input|permission|transient|internal) versus errors (unclassified surprises missing failureKind). Count only terminal outcomes in rates; treat excluded/nonterminal counts as separate diagnostic evidence, never as successes or failures. Prefer remediating unclassified errors first; treat high amber volume as avoidable-input/setup signal, not as unexplained instability.";
const SENTRY_RELIABILITY_CHECKLIST_ITEM = {
  check: "Inspected system.reliability and split ambers (classified) from errors (unclassified) for tools, plans, workflows, and conversational turns",
  weight: 10,
  kind: "tool_invoked",
  tool: "system",
  action: "reliability",
} as const;
const SENTRY_RAILWAY_STATUS_CHECKLIST_ITEM = {
  check: "Railway evidence collected: the railway tool had at least one successful status invocation this run.",
  weight: 10,
  kind: "tool_invoked",
  tool: "railway",
  action: "status",
} as const;
const SENTRY_PLATFORMS_STATUS_CHECKLIST_ITEM = {
  check: "Platforms evidence collected: the platforms tool had at least one successful environment-status invocation this run.",
  weight: 10,
  kind: "tool_invoked",
  tool: "platforms",
  action: "get_environment_status",
} as const;
const SENTRY_REQUIRED_SENSORS_SECTION = `## Required sensors (hard — first actions)
Before any classification, report rewrite, or end-state summary, successfully invoke all of:
1. \`platforms.get_environment_status\` for environment \`11\`
2. \`platforms.get_environment_status\` for environment \`12\`
3. \`railway.status\` with \`platformEnvironmentId: 11\`
4. \`railway.status\` with \`platformEnvironmentId: 12\`

Do not classify healthy from prior report state, platforms alone, or a previous run. A Sentinel self-degradation caused solely by missing these deterministic tool-coverage checks is a process-compliance miss, not a stage/production incident — cure it by invoking the required tools, not by raising an environment incident. The deterministic checklist terminates the run degraded without successful \`railway:status\` and \`platforms:get_environment_status\`.
`;
const SENTRY_CHANGESET_GATE = `## Recent changelist remediation gate
Before creating or reusing a task, repair handoff, conversation, or attention flag, compare every new or worsening software-defect candidate against recent Mantra Web changelists. Use bounded read-only evidence already available from \`platforms.get_build_status\`, \`platforms.get_environment_status\`, and recent \`railway.deployments\` for environment 11 and 12. Inspect up to 20 stage/main deployments from the last 24 hours, including builds still in progress, so a later deployment does not hide the relevant merged PR or commit.

Assign exactly one remediation disposition:
- \`unaddressed\`: no evidenced matching changelist or active repair exists.
- \`repair_active\`: an existing task, engineering session, plan, workflow, PR, build, or stage deployment is actively addressing the same signature.
- \`addressed_pending_live_promotion\`: a recent merged main changelist or stage build/deployment explicitly cures the same subsystem and failure mechanism, but production does not yet contain that cure.
- \`live_verified\`: the matching cure is in the current successful production deployment or the production symptom has disappeared after promotion.
- \`uncertain\`: evidence is unavailable, vague, or only keyword-similar. Treat this as \`unaddressed\` for notification safety.

A changelist match must cite a PR or commit SHA/message and explain how it addresses the observed failure mechanism. Shared words, neighboring subsystem work, a newer stage SHA by itself, or an unverified hypothesis are not a match. Never downgrade the truthful stage or production runtime classification because source is fixed elsewhere.

\`addressed_pending_live_promotion\`, \`repair_active\`, and \`live_verified\` suppress duplicate tasks, repair handoffs, new conversations, and attention flags. Persist the incident and remediation disposition in the canonical report instead. Alert Ray only when the matching build/deployment is blocked or failed, the incident materially worsens after that changelist, evidence shows the changelist does not cure the mechanism, or a distinct human decision beyond ordinary live promotion is required. Production promotion remains human-controlled; its mere pending state is not a blocked repair.
`;

/**
 * The Reliability Sentinel is a live code-owned Skill that predates the current
 * bootstrap fixture. Patch its single classification boundary monotonically so
 * runtime severity and remediation state cannot collapse into one alert decision.
 */
export async function migrateSentryRecentChangelistGate(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await db
      .select({
        id: skills.id,
        author: skills.author,
        customized: skills.customized,
        version: skills.version,
        description: skills.description,
        process: skills.process,
        outputSpec: skills.outputSpec,
        checklist: skills.checklist,
      })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "sentry")));
    if (!existing || existing.author !== "system" || existing.customized === true) return;
    const versionOrder = compareSkillVersions(existing.version, SENTRY_CHANGESET_GATE_VERSION);
    if (versionOrder === null || versionOrder >= 0) return;
    if (
      !existing.process.includes(SENTRY_RUN_EVIDENCE_MARKER)
      || !existing.process.includes(SENTRY_REPORT_MARKER)
    ) {
      log.warn(`Skipped sentry reliability migration from ${existing.version}: expected managed markers were not found`);
      return;
    }

    const hasChangesetGate = existing.process.includes("## Recent changelist remediation gate");
    let process = hasChangesetGate
      ? existing.process
      : existing.process.replace(
        `${SENTRY_RUN_EVIDENCE_MARKER}\n\n${SENTRY_REPORT_MARKER}`,
        `${SENTRY_RUN_EVIDENCE_MARKER}\n\n${SENTRY_CHANGESET_GATE}\n${SENTRY_REPORT_MARKER}`,
      );
    if (!process.includes(SENTRY_RELIABILITY_OUTCOMES_MARKER)) {
      process = process.replace(
        SENTRY_REPORT_MARKER,
        `${SENTRY_RELIABILITY_OUTCOMES_MARKER}\n\n${SENTRY_REPORT_MARKER}`,
      );
    }
    const description = hasChangesetGate
      ? existing.description
      : `${existing.description.replace(/\s+$/, "")} Checks recent merged and staged changelists before creating user attention or repair work.`;
    const outputSpec = existing.outputSpec.includes("remediationDisposition")
      ? existing.outputSpec
      : existing.outputSpec.replace(
        "`repairHandoff` (none|prepared|active|blocked plus task/plan/workflow/PR references)",
        "`remediationDisposition` (unaddressed|repair_active|addressed_pending_live_promotion|live_verified|uncertain plus PR/SHA/deployment evidence), `repairHandoff` (none|prepared|active|blocked plus task/plan/workflow/PR references)",
      );
    const mappedChecklist = (existing.checklist ?? []).map((item: any) => {
      if (typeof item?.check !== "string") return item;
      if (item.check.startsWith("Deduplicates incidents and does not create repeated issues")) {
        return {
          ...item,
          check: "Before any user alert or repair work, checks bounded recent merged/staged changelists, records one remediation disposition with PR/SHA/deployment evidence, and suppresses duplicate issues, tasks, plans, workflows, conversations, or attention when the same mechanism is already addressed or actively being repaired.",
        };
      }
      if (item.check.startsWith("For an eligible bounded software defect, prepares or reuses one protected engineering handoff")) {
        return {
          ...item,
          check: "For an eligible unaddressed bounded software defect, prepares or reuses one protected engineering handoff with complete evidence and canonical coding/stage-verification instructions; never performs code or provider writes directly from the timer run.",
        };
      }
      return item;
    });
    const checklist = mappedChecklist.some(
      (item: any) => item?.kind === "tool_invoked"
        && item?.tool === "system"
        && item?.action === "reliability",
    )
      ? mappedChecklist
      : [
        ...mappedChecklist,
        SENTRY_RELIABILITY_CHECKLIST_ITEM,
      ];

    const updated = await db
      .update(skills)
      .set({
        description,
        process,
        outputSpec,
        checklist,
        version: SENTRY_CHANGESET_GATE_VERSION,
        updatedAt: new Date(),
      })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, false),
        eq(skills.version, existing.version),
      ))
      .returning({ id: skills.id });
    if (updated.length > 0) {
      log.info(`Migrated Reliability Sentinel ${existing.version} → ${SENTRY_CHANGESET_GATE_VERSION} with recent-changelist remediation gate`);
      return;
    }
  }
}

/**
 * Front-load required railway.status + platforms.get_environment_status sensors
 * so healthy-shortcut runs cannot skip provider evidence and still look green.
 * Monotonic over the live non-lattice Reliability Sentinel row.
 */
export async function migrateSentryRequiredSensorsGate(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await db
      .select({
        id: skills.id,
        author: skills.author,
        customized: skills.customized,
        version: skills.version,
        process: skills.process,
        checklist: skills.checklist,
        scoreThreshold: skills.scoreThreshold,
      })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "sentry")));
    if (!existing || existing.author !== "system" || existing.customized === true) return;

    const versionOrder = compareSkillVersions(existing.version, SENTRY_REQUIRED_SENSORS_VERSION);
    if (versionOrder === null) return;
    // Already at/above 1.12 and carrying the required-sensor marker — done.
    if (versionOrder >= 0 && existing.process.includes(SENTRY_REQUIRED_SENSORS_MARKER)) return;
    // Below 1.12 without the live report contract cannot be patched safely.
    if (
      !existing.process.includes(SENTRY_RUN_EVIDENCE_MARKER)
      || !existing.process.includes(SENTRY_REPORT_MARKER)
      || !existing.process.includes(SENTRY_RUN_WINDOW_MARKER)
    ) {
      log.warn(`Skipped sentry required-sensors migration from ${existing.version}: expected managed markers were not found`);
      return;
    }

    let process = existing.process;
    if (!process.includes(SENTRY_REQUIRED_SENSORS_MARKER)) {
      process = process.replace(
        SENTRY_RUN_WINDOW_MARKER,
        `${SENTRY_REQUIRED_SENSORS_SECTION}\n${SENTRY_RUN_WINDOW_MARKER}`,
      );
      if (!process.includes(SENTRY_REQUIRED_SENSORS_MARKER)) {
        log.warn(`Skipped sentry required-sensors migration from ${existing.version}: could not insert required-sensors section`);
        return;
      }
    }

    const mappedChecklist = Array.isArray(existing.checklist) ? [...(existing.checklist as any[])] : [];
    const hasRailwayStatus = mappedChecklist.some(
      (item: any) => item?.kind === "tool_invoked"
        && item?.tool === "railway"
        && item?.action === "status",
    );
    const hasPlatformsStatus = mappedChecklist.some(
      (item: any) => item?.kind === "tool_invoked"
        && item?.tool === "platforms"
        && item?.action === "get_environment_status",
    );
    const checklist = [
      ...mappedChecklist,
      ...(hasRailwayStatus ? [] : [SENTRY_RAILWAY_STATUS_CHECKLIST_ITEM]),
      ...(hasPlatformsStatus ? [] : [SENTRY_PLATFORMS_STATUS_CHECKLIST_ITEM]),
    ];
    const scoreThreshold = typeof existing.scoreThreshold === "number"
      ? existing.scoreThreshold
      : 0.8;

    const updated = await db
      .update(skills)
      .set({
        process,
        checklist,
        scoreThreshold,
        version: SENTRY_REQUIRED_SENSORS_VERSION,
        updatedAt: new Date(),
      })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, false),
        eq(skills.version, existing.version),
      ))
      .returning({ id: skills.id });
    if (updated.length > 0) {
      log.info(`Migrated Reliability Sentinel ${existing.version} → ${SENTRY_REQUIRED_SENSORS_VERSION} with required railway/platforms sensors`);
      return;
    }
  }
}

export async function migrateSkillProcessUpdates(): Promise<void> {
  const migrations: Array<{ name: string; sentinel: string }> = [
    {
      name: "sleep",
      sentinel: "## Phase 1: Run the vNext Sleep Cycle",
    },
    {
      name: "brief-daily",
      sentinel: "Run the `learning` skill as a sub-skill every day",
    },
    {
      name: "reflect",
      sentinel: "## Cadence Semantics",
    },
  ];

  for (const { name, sentinel } of migrations) {
    const [existing] = await db.select({ id: skills.id, author: skills.author, customized: skills.customized, process: skills.process }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
    if (!existing || existing.author !== "system" || existing.customized === true) continue;
    if (!existing.process.includes(sentinel)) {
      const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === name);
      if (!def) continue;
      await db.update(skills).set({ process: def.process, updatedAt: new Date() }).where(eq(skills.id, existing.id));
      log.debug(`Updated skill "${name}" process to include "${sentinel}" (action-bias fix)`);
    }
  }

  const { getSetting, setSetting } = await import("./system-settings");


  const retiredPlanSkill = await getSetting<boolean>("retired_plan_skill_v1");
  if (!retiredPlanSkill) {
    const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "plan"), eq(skills.author, "system")));
    if (existing) {
      await db.delete(skills).where(eq(skills.id, existing.id));
      log.info(`Retired obsolete global plan Skill id=${existing.id}`);
    }
    await setSetting("retired_plan_skill_v1", true);
  }

}

export async function deleteZombieSkills(): Promise<void> {
  const { getSetting, setSetting } = await import("./system-settings");

  const deletedV1 = await getSetting<boolean>("zombie_skills_deleted_v1");
  if (!deletedV1) {
    const zombieNames = ["ooda-decide", "ooda-orient", "tactical-decide"];
    let count = 0;

    for (const name of zombieNames) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill "${name}" id=${existing.id}`);
        count++;
      }
    }

    await setSetting("zombie_skills_deleted_v1", true);
    log.debug(`Zombie skill cleanup v1 complete: ${count} deleted`);
  }

  const deletedV2 = await getSetting<boolean>("zombie_skills_deleted_v2");
  if (!deletedV2) {
    const zombieNamesV2 = [
      "introspect-morning",
      "introspect-evening",
      "pulse-sleep",
      "pulse-meditate",
      "pulse-engage",
      "pulse-dream",
    ];
    let countV2 = 0;

    for (const name of zombieNamesV2) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v2 "${name}" id=${existing.id}`);
        countV2++;
      }
    }

    await setSetting("zombie_skills_deleted_v2", true);
    log.debug(`Zombie skill cleanup v2 complete: ${countV2} deleted`);
  }

  const deletedV3 = await getSetting<boolean>("zombie_skills_deleted_v3");
  if (!deletedV3) {
    const zombieNamesV3 = [
      "pulse-world-model",
    ];
    let countV3 = 0;

    for (const name of zombieNamesV3) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v3 "${name}" id=${existing.id}`);
        countV3++;
      }
    }

    await setSetting("zombie_skills_deleted_v3", true);
    log.debug(`Zombie skill cleanup v3 complete: ${countV3} deleted`);
  }

  const deletedV4 = await getSetting<boolean>("zombie_skills_deleted_v4");
  if (!deletedV4) {
    const zombieNamesV4 = [
      "memory-hygiene",
    ];
    let countV4 = 0;

    for (const name of zombieNamesV4) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v4 "${name}" id=${existing.id}`);
        countV4++;
      }
    }

    await setSetting("zombie_skills_deleted_v4", true);
    log.debug(`Zombie skill cleanup v4 complete: ${countV4} deleted`);
  }

  const deletedV5 = await getSetting<boolean>("zombie_skills_deleted_v5");
  if (!deletedV5) {
    // Exact legacy names remain here only so older installations cannot retain
    // deleted skills after the Beliefs subsystem is gone.
    const zombieNamesV5 = [
      "chat-generateissuetitle",
      "act-generate-artifact",
      "act-evaluate-satisfaction",
      "myelination-belief-extract",
      "myelination-belief-crossref",
    ];
    let countV5 = 0;

    for (const name of zombieNamesV5) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v5 "${name}" id=${existing.id}`);
        countV5++;
      }
    }

    await setSetting("zombie_skills_deleted_v5", true);
    log.debug(`Zombie skill cleanup v5 complete: ${countV5} deleted`);
  }

  const deletedV6 = await getSetting<boolean>("zombie_skills_deleted_v6");
  if (!deletedV6) {
    const zombieNamesV6 = [
      "code-architect",
      "code-test",
      "code-review",
      "code-implement",
      "chat-generateconversationtitle",
    ];
    let countV6 = 0;

    for (const name of zombieNamesV6) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v6 "${name}" id=${existing.id}`);
        countV6++;
      }
    }

    await setSetting("zombie_skills_deleted_v6", true);
    log.debug(`Zombie skill cleanup v6 complete: ${countV6} deleted`);
  }

  const deletedV7 = await getSetting<boolean>("zombie_skills_deleted_v7");
  if (!deletedV7) {
    const zombieNamesV7 = [
      "brief-daily-live",
      "tools-mergewebcontentsummaries",
      "tools-summarizecontent",
      "tools-summarizewebcontent",
    ];
    let countV7 = 0;

    for (const name of zombieNamesV7) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v7 "${name}" id=${existing.id}`);
        countV7++;
      }
    }

    await setSetting("zombie_skills_deleted_v7", true);
    log.debug(`Zombie skill cleanup v7 complete: ${countV7} deleted`);
  }

  const deletedV8 = await getSetting<boolean>("zombie_skills_deleted_v8");
  if (!deletedV8) {
    const zombieNamesV8 = [
      "investigate",
      "note-process",
      "reflect-weekly",
      "principles-generate",
      "tools-summarizecontent",
      "tools-summarizewebcontent",
      "tools-mergewebcontentsummaries",
      "myelination-concept-crossref",
      "myelination-concept-extract",
      "agent-classifycomplexity",
      "chat-compactrunhistory",
      "tools-indexcontent",
      "myelination-cross-concept",
      "myelination-link",
      "myelination-mid-merge",
      "myelination-mid-merge-consolidate",
      "myelination-summarize",
      "people-deepsummary",
      "people-quicksummary",
      "strategy-discovermoves",
      "strategy-evaluatemove",
      "strategy-evaluatestate",
    ];
    let countV8 = 0;

    for (const name of zombieNamesV8) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v8 "${name}" id=${existing.id}`);
        countV8++;
      }
    }

    await setSetting("zombie_skills_deleted_v8", true);
    log.debug(`Zombie skill cleanup v8 complete: ${countV8} deleted`);
  }

  const deletedV9 = await getSetting<boolean>("zombie_skills_deleted_v9");
  if (!deletedV9) {
    const zombieNamesV9 = [
      "review-daily",
      "detect-misalignment",
      "spec",
      "spec-write",
      "opportunity-research",
    ];
    let countV9 = 0;

    for (const name of zombieNamesV9) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v9 "${name}" id=${existing.id}`);
        countV9++;
      }
    }

    await setSetting("zombie_skills_deleted_v9", true);
    log.debug(`Zombie skill cleanup v9 complete: ${countV9} deleted`);
  }

  const deletedV10 = await getSetting<boolean>("zombie_skills_deleted_v10");
  if (!deletedV10) {
    const zombieNamesV10 = [
      "intention-prioritize",
      "intention-advance",
      "council-advocate",
    ];
    let countV10 = 0;

    for (const name of zombieNamesV10) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted zombie skill v10 "${name}" id=${existing.id}`);
        countV10++;
      }
    }

    await setSetting("zombie_skills_deleted_v10", true);
    log.debug(`Zombie skill cleanup v10 complete: ${countV10} deleted`);
  }


  const deletedV11 = await getSetting<boolean>("zombie_skills_deleted_v11");
  if (!deletedV11) {
    const zombieNamesV11 = [
      "plan-weekly",
      "plan-monthly",
      "reflect-daily",
      "reflect-monthly",
      "reflect-quarterly",
      "reflect-annual",
    ];
    let countV11 = 0;

    for (const name of zombieNamesV11) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted parameterized planning predecessor skill "${name}" id=${existing.id}`);
        countV11++;
      }
    }

    await setSetting("zombie_skills_deleted_v11", true);
    log.debug(`Parameterized planning predecessor cleanup v11 complete: ${countV11} deleted`);
  }

  const deletedV12 = await getSetting<boolean>("zombie_skills_deleted_v12");
  if (!deletedV12) {
    const zombieNamesV12 = ["reflect-annual"];
    let countV12 = 0;

    for (const name of zombieNamesV12) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted annual reflection predecessor skill "${name}" id=${existing.id}`);
        countV12++;
      }
    }

    await setSetting("zombie_skills_deleted_v12", true);
    log.debug(`Annual reflection predecessor cleanup v12 complete: ${countV12} deleted`);
  }


  const deletedV13 = await getSetting<boolean>("retired_autonomy_predecessors_deleted_v13");
  if (!deletedV13) {
    const retiredAutonomyPredecessors = [
      "advance",
      "prioritize",
      "intention-advance",
      "intention-prioritize",
      "strategic-orient",
    ];
    let countV13 = 0;

    for (const name of retiredAutonomyPredecessors) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted retired autonomy predecessor skill "${name}" id=${existing.id}`);
        countV13++;
      }
    }

    const blankAutonomyRows = await db
      .select({ id: skills.id, description: skills.description })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "")));

    for (const row of blankAutonomyRows) {
      if (row.description?.includes("autonomous scan-and-execute loop")) {
        const [autonomy] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "autonomy")));
        if (autonomy) {
          await db.delete(skills).where(eq(skills.id, row.id));
          log.debug(`Deleted duplicate blank-name autonomy skill id=${row.id}`);
        } else {
          await db.update(skills).set({ name: "autonomy", updatedAt: new Date() }).where(eq(skills.id, row.id));
          log.debug(`Renamed blank-name autonomy skill id=${row.id} to "autonomy"`);
        }
        countV13++;
      }
    }

    await setSetting("retired_autonomy_predecessors_deleted_v13", true);
    log.debug(`Retired autonomy predecessor cleanup v13 complete: ${countV13} changed`);
  }

  const deletedV14 = await getSetting<boolean>("retired_council_skills_deleted_v14");
  if (!deletedV14) {
    const retiredCouncilSkills = ["council", "advocate", "council-advocate"];
    let countV14 = 0;
    for (const name of retiredCouncilSkills) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted retired council skill "${name}" id=${existing.id}`);
        countV14++;
      }
    }
    await setSetting("retired_council_skills_deleted_v14", true);
    log.debug(`Retired council skill cleanup v14 complete: ${countV14} deleted`);
  }

  // Delete any skill with an empty name (sleep ghost)
  const emptyNameRows = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "")));
  for (const row of emptyNameRows) {
    await db.delete(skills).where(eq(skills.id, row.id));
    log.debug(`Deleted empty-name ghost skill id=${row.id}`);
  }

  const retiredBuiltinNames = [
    "audit",
    "decompose",
    "sleep-forgetting",
    // Legacy short/mid/long memory lifecycle skills, superseded by the vNext "sleep" cycle.
    "consolidate",
    "integrate",
  ];
  let retiredCount = 0;

  for (const name of retiredBuiltinNames) {
    const [existing] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
    if (existing) {
      await db.delete(skills).where(eq(skills.id, existing.id));
      log.debug(`Deleted retired builtin skill "${name}" id=${existing.id}`);
      retiredCount++;
    }
  }

  if (retiredCount > 0) {
    log.debug(`Retired builtin skill cleanup complete: ${retiredCount} deleted`);
  }
}

export async function getSkillProcess(name: string): Promise<string> {
  const { resolveSkillRunName } = await import("./skill-identities");
  const skillName = resolveSkillRunName(PROMPT_NAME_TO_SKILL[name] || name);
  const { storage } = await import("./storage");
  const skill = await storage.getSkillByName(skillName);
  if (skill) return skill.process;
  throw new Error(`Required skill not found in DB: "${name}". Runnable skills must be seeded before use.`);
}

export async function getSkillEntry(name: string): Promise<{ process: string; activity: string }> {
  const { resolveSkillRunName } = await import("./skill-identities");
  const skillName = resolveSkillRunName(PROMPT_NAME_TO_SKILL[name] || name);
  const { storage } = await import("./storage");
  const skill = await storage.getSkillByName(skillName);
  if (skill) return { process: skill.process, activity: skill.activity };
  throw new Error(`Required skill not found in DB: "${name}". Runnable skills must be seeded before use.`);
}

export async function ensureEmailTriageLibraryPage(): Promise<void> {
  const pageId = "email-triage-unsubscribe-whitelist";
  const existing = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.id, pageId));
  if (existing.length > 0) return;

  const bySlug = await db.select({ id: libraryPages.id }).from(libraryPages).where(eq(libraryPages.slug, pageId));
  if (bySlug.length > 0) return;

  const plainTextContent = [
    "Email Triage — Unsubscribe Whitelist",
    "",
    "Senders listed here should be classified as 📋 (FYI) instead of 🗑️ (Noise),",
    "even if their emails look like newsletters or automated notifications.",
    "",
    "Format: one sender email address or domain per line.",
    "",
    "## Whitelisted Senders",
    "",
    "(none yet — add sender addresses or domains below, e.g. updates@example.com or @example.com)",
  ].join("\n");

  const content = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Email Triage — Unsubscribe Whitelist" }] },
      { type: "paragraph", content: [{ type: "text", text: "Senders listed here should be classified as 📋 (FYI) instead of 🗑️ (Noise), even if their emails look like newsletters or automated notifications." }] },
      { type: "paragraph", content: [{ type: "text", text: "Format: one sender email address or domain per line." }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Whitelisted Senders" }] },
      { type: "paragraph", content: [{ type: "text", text: "(none yet — add sender addresses or domains below, e.g. updates@example.com or @example.com)" }] },
    ],
  };

  await db.insert(libraryPages).values({
    id: pageId,
    title: "Email Triage — Unsubscribe Whitelist",
    slug: pageId,
    content,
    plainTextContent,
    tags: ["email-triage", "system"],
    status: "active",
    emoji: "📧",
    sortOrder: 0,
  });

  log.debug(`Created library page "${pageId}"`);
}
