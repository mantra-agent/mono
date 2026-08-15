import { createLogger } from "./log";
import { db } from "./db";
import { getPostgresErrorDetails } from "./postgres-errors";
import { skills, libraryPages, personas, skillPersonaPreferences } from "@shared/schema";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { BUILTIN_SKILL_DEFAULTS, type SkillDefault } from "./skill-defaults";
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

function builtinSkillDefinitionPatch(def: (typeof BUILTIN_SKILL_DEFAULTS)[number]) {
  return {
    description: def.description,
    category: def.category,
    activity: def.activity,
    process: def.process,
    whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
    outputSpec: def.outputSpec ?? "See process instructions",
    checklist: def.checklist ?? [],
    scoreThreshold: def.scoreThreshold ?? null,
    version: def.version || "1.0",
    author: def.author || "system",
    status: "active",
    addToMemory: def.addToMemory ?? true,
    pinnedToContext: def.pinnedToContext ?? false,
    ...(def.sessionType ? { sessionType: def.sessionType } : {}),
    updatedAt: new Date(),
  };
}

function compareSkillVersions(left: string, right: string): number | null {
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

const PLAN_PERIOD_CONTRACT_VERSION = "1.2";
const PLAN_PERIOD_CONTRACT_MARKER = "## Scheduled Period Contract (v1.2)";
const PLAN_PERIOD_CONTRACT = `${PLAN_PERIOD_CONTRACT_MARKER}

This contract overrides any conflicting generic period wording below while preserving all customized planning instructions.

For a scheduled run, preContext supplies the authoritative \`planningMode: review_current_plan_next\`, timezone, reviewPeriod, targetPeriod, and parentPeriod. Review-period goals are read-only transition context: classify them as complete, carry forward, change, or drop, but never mutate them. Only goals, artifacts, and check-in metadata scoped to targetPeriod may be created or changed. Use the explicit period keys instead of relative wall-clock interpretations.`;

const PLAN_V11_DESCRIPTION = "Conversation-first parameterized planning skill for daily, weekly, monthly, quarterly, and annual cadences. It starts a short alignment conversation, helps Ray choose up to 3 canonical goals, then creates the plan artifact only after Ray confirms.";
const PLAN_V11_WHEN_TO_USE = "Use for scheduled or manual planning at any cadence when Ray needs to align on canonical goals for a target period. The first response should be conversational and ask for confirmation, not produce the plan artifact.";
const PLAN_V11_OUTPUT_SPEC = "Initial turn: a compact planning frame and 1-3 questions/proposed goals for Ray. After Ray confirms: up to 3 canonical goals created/updated/selected, parent links where clear, and a concise Library plan artifact linked through check-in metadata where supported.";

const PLAN_V11_CHECKLIST_REPLACEMENTS = new Map<string, string[]>([
  [
    "First response is conversation-first: no Library page, priorities metadata, or goal mutations before Ray confirms the target goals",
    ["First response is conversation-first: no Library page, check-in metadata, or goal mutations before Ray confirms the target-period goals"],
  ],
  [
    "PreContext cadence and target period are used to identify target horizon, parent horizon, and artifact metadata",
    ["PreContext planningMode, timezone, reviewPeriod, targetPeriod, and parentPeriod are used exactly; scheduled planning reviews the current period and plans the next period"],
  ],
  [
    "Only future planning context is used by default: parent goals, existing target goals, current projects/decisions, and relevant calendar constraints",
    [
      "Review-period goals are used only to classify complete, carry forward, change, or drop; they are never mutated by the planning run",
      "Opening context stays bounded to parent goals, existing target-period goals, narrow review-period goal status, and relevant future calendar/project constraints",
    ],
  ],
  [
    "After confirmation, no more than 3 active target-horizon goals are selected/created and parent links are created where clear",
    ["After confirmation, no more than 3 active goals scoped to targetPeriod are selected/created and parent links are created where clear"],
  ],
  [
    "After confirmation, the plan artifact is saved and linked via supported check-in metadata such as goals.set_daily_plan, goals.set_weekly_plan, goals.set_monthly_plan, or goals.set_quarterly_plan",
    ["After confirmation, only the targetPeriod plan artifact is saved and linked via supported check-in metadata such as goals.set_daily_plan, goals.set_weekly_plan, goals.set_monthly_plan, or goals.set_quarterly_plan"],
  ],
]);

function mergePlanV12Checklist(
  checklist: unknown,
  canonicalChecklist: SkillDefault["checklist"],
): Array<Record<string, unknown> & { check: string; weight: number }> {
  const existing = Array.isArray(checklist) ? checklist : [];
  const merged: Array<Record<string, unknown> & { check: string; weight: number }> = [];
  for (const item of existing) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown> & { check?: unknown; weight?: unknown };
    if (typeof candidate.check !== "string" || typeof candidate.weight !== "number") continue;
    const replacements = PLAN_V11_CHECKLIST_REPLACEMENTS.get(candidate.check);
    if (!replacements) {
      merged.push({ ...candidate, check: candidate.check, weight: candidate.weight });
      continue;
    }
    for (const check of replacements) {
      const canonical = canonicalChecklist?.find((entry) => entry.check === check);
      merged.push({
        ...candidate,
        check,
        weight: canonical?.weight ?? candidate.weight,
      });
    }
  }
  for (const required of canonicalChecklist ?? []) {
    if (!merged.some((item) => item.check === required.check)) merged.push({ ...required });
  }
  return merged;
}

/**
 * Before copy-on-write Skill overrides, edits marked the global built-in row as
 * customized. Preserve that legacy content while merging the safety-critical
 * scheduled-period delta. Current private overrides remain untouched.
 */
export async function migrateCustomizedPlanPeriodContract(): Promise<void> {
  const canonical = BUILTIN_SKILL_DEFAULTS.find((definition) => definition.name === "plan");
  if (!canonical || canonical.version !== PLAN_PERIOD_CONTRACT_VERSION) {
    log.error("Cannot reconcile customized Plan skill: canonical v1.2 definition is missing");
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await db
      .select({
        id: skills.id,
        author: skills.author,
        customized: skills.customized,
        version: skills.version,
        description: skills.description,
        process: skills.process,
        whenToUse: skills.whenToUse,
        outputSpec: skills.outputSpec,
        checklist: skills.checklist,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "plan")));
    if (!existing || existing.author !== "system" || existing.customized !== true) return;
    if (existing.version !== "1.1") {
      const order = compareSkillVersions(existing.version, PLAN_PERIOD_CONTRACT_VERSION);
      if (order !== null && order >= 0) return;
      log.warn("Skipped customized Plan period reconciliation", {
        persistedVersion: existing.version,
        targetVersion: PLAN_PERIOD_CONTRACT_VERSION,
        reason: order === null ? "invalid_version" : "unsupported_base_version",
      });
      return;
    }

    const process = existing.process.includes(PLAN_PERIOD_CONTRACT_MARKER)
      ? existing.process
      : `${PLAN_PERIOD_CONTRACT}\n\n${existing.process}`;
    const [updated] = await db
      .update(skills)
      .set({
        description: existing.description === PLAN_V11_DESCRIPTION ? canonical.description : existing.description,
        process,
        whenToUse: existing.whenToUse === PLAN_V11_WHEN_TO_USE ? (canonical.whenToUse ?? existing.whenToUse) : existing.whenToUse,
        outputSpec: existing.outputSpec === PLAN_V11_OUTPUT_SPEC ? (canonical.outputSpec ?? existing.outputSpec) : existing.outputSpec,
        checklist: mergePlanV12Checklist(existing.checklist, canonical.checklist),
        version: PLAN_PERIOD_CONTRACT_VERSION,
        updatedAt: new Date(),
      })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, true),
        eq(skills.version, existing.version),
        eq(skills.updatedAt, existing.updatedAt),
      ))
      .returning({ id: skills.id });
    if (updated) {
      log.info("Reconciled customized builtin Plan 1.1 → 1.2 without replacing customized content");
      return;
    }
  }
}

const DAILY_BRIEF_COMPOSITION_CONTRACT_VERSION = "7.9";
const DAILY_BRIEF_REQUIRED_CHILD_SKILLS = ["affirm", "learning"] as const;

function mergeDailyBriefCompositionChecklist(
  checklist: unknown,
  canonicalChecklist: SkillDefault["checklist"],
): Array<Record<string, unknown> & { check: string; weight: number }> {
  const existing = Array.isArray(checklist)
    ? checklist.filter((item): item is Record<string, unknown> & { check: string; weight: number } => (
        Boolean(item)
        && typeof item === "object"
        && typeof item.check === "string"
        && typeof item.weight === "number"
      ))
    : [];
  const required = (canonicalChecklist ?? []).filter((item) => (
    item.kind === "child_skill_invoked"
    && typeof item.skill === "string"
    && DAILY_BRIEF_REQUIRED_CHILD_SKILLS.includes(item.skill as typeof DAILY_BRIEF_REQUIRED_CHILD_SKILLS[number])
  ));
  const withoutLegacyRequiredChildren = existing.filter((item) => !(
    item.kind === "child_skill_invoked"
    && typeof item.skill === "string"
    && DAILY_BRIEF_REQUIRED_CHILD_SKILLS.includes(item.skill as typeof DAILY_BRIEF_REQUIRED_CHILD_SKILLS[number])
  ));
  return [
    ...required.map((item) => ({ ...item })),
    ...withoutLegacyRequiredChildren.map((item) => ({ ...item })),
  ];
}

/**
 * Legacy edits customized the global Daily Brief row before Skill copy-on-write.
 * Preserve that authored brief while merging only the structural composition
 * gates and nonzero quality threshold required to prevent inline false greens.
 */
export async function migrateCustomizedDailyBriefCompositionContract(): Promise<void> {
  const canonical = BUILTIN_SKILL_DEFAULTS.find((definition) => definition.name === "brief-daily");
  if (!canonical || canonical.version !== DAILY_BRIEF_COMPOSITION_CONTRACT_VERSION) {
    log.error("Cannot reconcile customized Daily Brief skill: canonical v7.9 definition is missing");
    return;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await db
      .select({
        id: skills.id,
        author: skills.author,
        customized: skills.customized,
        version: skills.version,
        checklist: skills.checklist,
        updatedAt: skills.updatedAt,
      })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "brief-daily")));
    if (!existing || existing.author !== "system" || existing.customized !== true) return;
    if (existing.version !== "7.7") {
      const order = compareSkillVersions(existing.version, DAILY_BRIEF_COMPOSITION_CONTRACT_VERSION);
      if (order !== null && order >= 0) return;
      log.warn("Skipped customized Daily Brief composition reconciliation", {
        persistedVersion: existing.version,
        targetVersion: DAILY_BRIEF_COMPOSITION_CONTRACT_VERSION,
        reason: order === null ? "invalid_version" : "unsupported_base_version",
      });
      return;
    }

    const [updated] = await db
      .update(skills)
      .set({
        checklist: mergeDailyBriefCompositionChecklist(existing.checklist, canonical.checklist),
        scoreThreshold: canonical.scoreThreshold ?? 0.8,
        version: DAILY_BRIEF_COMPOSITION_CONTRACT_VERSION,
        updatedAt: new Date(),
      })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, true),
        eq(skills.version, existing.version),
        eq(skills.updatedAt, existing.updatedAt),
      ))
      .returning({ id: skills.id });
    if (updated) {
      log.info("Reconciled customized builtin Daily Brief 7.7 → 7.9 with structural composition gates");
      return;
    }
  }
}

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
        for (let attempt = 0; attempt < 3; attempt++) {
          const versionOrder = compareSkillVersions(existing.version, defVersion);
          if (versionOrder === null) {
            log.warn(`Skipped builtin skill sync for "${def.name}": invalid version ${existing.version} or ${defVersion}`);
            break;
          }
          if (versionOrder > 0) {
            if (existing.author === "system" && existing.customized !== true) {
              log.warn(`Skipped builtin skill downgrade for "${def.name}" ${existing.version} → ${defVersion}`);
            }
            break;
          }
          if (
            versionOrder === 0 ||
            existing.author !== "system" ||
            existing.customized === true
          ) {
            break;
          }
          const updated = await db
            .update(skills)
            .set(builtinSkillDefinitionPatch(def))
            .where(
              and(
                eq(skills.id, existing.id),
                eq(skills.author, "system"),
                eq(skills.customized, false),
                eq(skills.version, existing.version),
              ),
            )
            .returning({ id: skills.id });
          if (updated.length > 0) {
            log.info(`Synchronized builtin skill "${def.name}" ${existing.version} → ${defVersion}`);
            break;
          }
          [existing] = await db
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
            log.warn(`Stopped builtin skill sync for "${def.name}": canonical identity changed during reconciliation`);
            break;
          }
          if (!existing) break;
        }
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

export async function migrateSkillProcessToToolBased(): Promise<void> {
  const skillsToMigrate: string[] = [];
  for (const name of skillsToMigrate) {
    const [existing] = await db.select({ id: skills.id, process: skills.process }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
    if (!existing) continue;
    if (existing.process.includes("Respond with a JSON object")) {
      const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === name);
      if (!def) continue;
      await db.update(skills).set({ process: def.process, updatedAt: new Date() }).where(eq(skills.id, existing.id));
      log.debug(`Migrated skill "${name}" process from JSON output to tool-based mutations`);
    }
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

const AUTONOMY_MEETING_PROTOCOL_V15 = `## Meeting-readiness protocol

For each upcoming external or high-prep meeting in the relevant planning window:

1. Inspect canonical meeting metadata for a private agenda and inspect linked artifacts for an existing brief.
2. Apply closed-loop run-history reconciliation using the meeting event ID, title, date, participants, agenda conversation, linked artifacts, and any prior surfaced result. Treat matching unresolved work as \`already_active\`. Never create parallel conversations or duplicate briefs.
3. If the agenda is missing and no matching active agenda request exists, start one conversation about the agenda. Use the meeting title, date, participants, People records and interactions, related sessions, goals, projects, decisions, email, and relevant memories to make a concrete first draft. Put the proposed agenda directly in the opening chat message, not in a Library page. Ask Ray to confirm or revise it. Record the conversation and resolution criteria in the ledger.
4. If an agenda exists but no linked brief exists, create or update one canonical Library brief, link it to the meeting with artifact kind \`brief\`, and surface it once for review. Build the brief from the agenda first, then enrich it with participant context, interactions, related sessions, goals, projects, decisions, email, and relevant memories.
5. If both agenda and linked brief exist, verify readiness and take no duplicate action. Update an existing brief only when new material evidence changes preparation meaningfully.
6. Never publish a private Mantra agenda into the shared calendar description. Use meeting metadata for agenda and meeting artifact links for briefs.

The dependency is strict: **missing agenda → agenda conversation → confirmed/stored agenda → linked brief**. A brief must never be created before an agenda exists.`;

const AUTONOMY_MEETING_PROTOCOL_V16 = `## Meeting-readiness protocol

For each upcoming external or high-prep meeting in the relevant planning window:

1. Inspect canonical meeting metadata and resolve its single preparation page from \`agendaLibraryPageId\`. Agenda and brief preparation are sections of that page, never separate artifacts.
2. Apply closed-loop run-history reconciliation using the meeting event ID, title, date, participants, agenda conversation, canonical preparation page, and any prior surfaced result. Treat matching unresolved work as \`already_active\`. Never create parallel conversations or duplicate pages.
3. If the agenda is missing and no matching active agenda request exists, start one conversation about the agenda. Use the meeting title, date, participants, People records and interactions, related sessions, goals, projects, decisions, email, and relevant memories to make a concrete first draft. Put the proposed agenda directly in the opening chat message. Ask Ray to confirm or revise it. Record the conversation and resolution criteria in the ledger.
4. Once the agenda is confirmed, resolve the canonical preparation page. If absent, create one page and claim it through meetings action=\`set_metadata\` with \`agendaLibraryPageId\`. If it exists, update that page. Add briefing context beneath the agenda on the same page and surface it once for review.
5. If the canonical page already contains the agenda and briefing context, verify readiness and take no duplicate action. Update it only when new material evidence changes preparation meaningfully.
6. Never publish private Mantra preparation into the shared calendar description. Use meeting metadata for the canonical page. Use \`link_artifact\` only for distinct non-preparation artifacts with an explicit kind such as research, follow_up, or recap.

The dependency is strict: **missing agenda → agenda conversation → confirmed agenda → one canonical preparation page**.`;

/**
 * Targeted monotonic migration for the live autonomy v1.5 policy. The checked-in
 * bootstrap fixture is older, so replacing the full definition would erase
 * closed-loop deduplication and opportunity-management policy. Patch only the
 * superseded meeting section and version under the same system/unmodified guard.
 */
export async function migrateAutonomyCanonicalMeetingPrep(): Promise<void> {
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
      .where(and(eq(skills.scope, "global"), eq(skills.name, "autonomy")));
    if (!existing || existing.author !== "system" || existing.customized === true) return;
    const versionOrder = compareSkillVersions(existing.version, "1.6");
    if (versionOrder === null || versionOrder >= 0) return;
    if (!existing.process.includes(AUTONOMY_MEETING_PROTOCOL_V15)) {
      log.warn(`Skipped autonomy canonical prep migration from ${existing.version}: expected v1.5 meeting protocol was not found`);
      return;
    }

    const process = existing.process.replace(AUTONOMY_MEETING_PROTOCOL_V15, AUTONOMY_MEETING_PROTOCOL_V16);
    const description = existing.description
      .replace("audits meetings for agenda-then-brief readiness", "audits meetings for single-page preparation readiness");
    const outputSpec = existing.outputSpec
      .replace("meeting-readiness results showing agenda-before-brief ordering", "meeting-readiness results showing one canonical preparation page");
    const checklist = (existing.checklist ?? []).map((item: any) => {
      if (typeof item?.check !== "string") return item;
      if (item.check.includes("missing agenda → agenda conversation → stored agenda → linked brief")) {
        return { ...item, check: item.check.replace("missing agenda → agenda conversation → stored agenda → linked brief", "missing agenda → agenda conversation → confirmed agenda → one canonical preparation page") };
      }
      if (item.check.includes("single canonical linked meeting brief only after an agenda exists")) {
        return { ...item, check: "Creates or updates the meeting's single canonical preparation page only after the agenda is confirmed, and continues existing meeting work rather than creating duplicate asks, conversations, or pages" };
      }
      return item;
    });

    const updated = await db
      .update(skills)
      .set({ description, process, outputSpec, checklist, version: "1.6", updatedAt: new Date() })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, false),
        eq(skills.version, existing.version),
      ))
      .returning({ id: skills.id });
    if (updated.length > 0) {
      log.info(`Migrated autonomy meeting preparation policy ${existing.version} → 1.6 without replacing newer live content`);
      return;
    }
  }
}

const AUTONOMY_PROVENANCE_VERIFICATION_V17 = `## Session-ledger verification

Sessions remain the universal execution ledger, but routine reconciliation is provenance-first:

1. Enumerate changed timers, skill runs, plan/workflow attempts, tasks, and sessions from their canonical status/timestamp fields since the last checkpoint.
2. Retain and follow exact session IDs already attached to those producers. Inspect authoritative messages by exact ID with \`session.get_messages\` when outcome evidence is needed.
3. Use \`session.list\` for bounded metadata discovery when provenance is incomplete. Reserve \`session.search\` for historical recovery, human recall, or genuinely missing identity; do not use guessed keywords as the normal proof that scheduled work ran.
4. Reconcile terminal status and canonical artifacts/tasks from exact records. A fuzzy text match is discovery evidence, never execution identity.
`;

export async function migrateAutonomyProvenanceVerification(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await db
      .select({
        id: skills.id,
        author: skills.author,
        customized: skills.customized,
        version: skills.version,
        process: skills.process,
      })
      .from(skills)
      .where(and(eq(skills.scope, "global"), eq(skills.name, "autonomy")));
    if (!existing || existing.author !== "system" || existing.customized === true) return;
    const versionOrder = compareSkillVersions(existing.version, "1.7");
    if (versionOrder === null || versionOrder >= 0) return;
    if (existing.version !== "1.6" || !existing.process.includes(AUTONOMY_MEETING_PROTOCOL_V16)) {
      log.warn(`Skipped autonomy provenance verification migration from ${existing.version}: expected v1.6 canonical policy was not found`);
      return;
    }

    const process = existing.process.includes("## Session-ledger verification")
      ? existing.process
      : `${existing.process.trim()}\n\n${AUTONOMY_PROVENANCE_VERIFICATION_V17.trim()}`;
    const updated = await db
      .update(skills)
      .set({ process, version: "1.7", updatedAt: new Date() })
      .where(and(
        eq(skills.id, existing.id),
        eq(skills.author, "system"),
        eq(skills.customized, false),
        eq(skills.version, existing.version),
      ))
      .returning({ id: skills.id });
    if (updated.length > 0) {
      log.info(`Migrated autonomy verification policy ${existing.version} → 1.7 without replacing newer live content`);
      return;
    }
  }
}

export async function migrateDailyBriefCanonicalMeetingPrep(): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id, author: skills.author, customized: skills.customized, version: skills.version, process: skills.process })
    .from(skills)
    .where(and(eq(skills.scope, "global"), eq(skills.name, "brief-daily")));
  if (!existing || existing.author !== "system" || existing.customized === true) return;
  const versionOrder = compareSkillVersions(existing.version, "7.7");
  if (versionOrder === null || versionOrder >= 0) return;
  if (existing.process.includes("A meeting has one canonical preparation page")) return;

  const meetingPrepMarker = "7. **Meeting prep** (progressive disclosure):";
  const weatherMarker = "8. **Weather:**";
  const start = existing.process.indexOf(meetingPrepMarker);
  const end = existing.process.indexOf(weatherMarker, start);
  if (start < 0 || end < 0) {
    log.warn(`Skipped Daily Brief canonical prep migration from ${existing.version}: meeting-prep section was not found`);
    return;
  }
  const replacement = `${meetingPrepMarker}\n   - One-liner: time, title, key attendees\n   - People context only if it changes how Ray should show up\n   - On light days (Tue/Thu), just list the schedule without prep notes\n   - A meeting has one canonical preparation page. Resolve it from meeting metadata. If absent, claim the page with meetings action=set_metadata and agendaLibraryPageId. Update that same page for all agenda and brief preparation. Never create or link a second brief page. Use meetings action=link_artifact only for distinct non-preparation artifacts with an explicit kind such as research, follow_up, or recap.\n\n`;
  const process = `${existing.process.slice(0, start)}${replacement}${existing.process.slice(end)}`;
  const updated = await db
    .update(skills)
    .set({ process, version: "7.7", updatedAt: new Date() })
    .where(and(
      eq(skills.id, existing.id),
      eq(skills.author, "system"),
      eq(skills.customized, false),
      eq(skills.version, existing.version),
    ))
    .returning({ id: skills.id });
  if (updated.length > 0) {
    log.info(`Migrated Daily Brief meeting preparation policy ${existing.version} → 7.7 without replacing newer live content`);
  }
}

const SENTRY_CHANGESET_GATE_VERSION = "1.10";
const SENTRY_RUN_EVIDENCE_MARKER = "8. Inspect recent `sentry` skill runs and open system issues/tasks/sessions when useful. Deduplicate by normalized signature + environment + likely subsystem. Update or reference an existing incident instead of creating another.";
const SENTRY_REPORT_MARKER = "## Canonical report page";
const SENTRY_RELIABILITY_OUTCOMES_MARKER = "11. Inspect `system.reliability` for bounded recent windows and explicitly evaluate the canonical success/failure outcomes for tool executions, plan steps, workflow runs, and conversational turns. Split failures into ambers (classified: input|permission|transient|internal) versus errors (unclassified surprises missing failureKind). Count only terminal outcomes in rates; treat excluded/nonterminal counts as separate diagnostic evidence, never as successes or failures. Prefer remediating unclassified errors first; treat high amber volume as avoidable-input/setup signal, not as unexplained instability.";
const SENTRY_RELIABILITY_CHECKLIST_ITEM = {
  check: "Inspected system.reliability and split ambers (classified) from errors (unclassified) for tools, plans, workflows, and conversational turns",
  weight: 10,
  kind: "tool_invoked",
  tool: "system",
  action: "reliability",
} as const;
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
    {
      name: "plan",
      sentinel: "## Non-Negotiable Flow",
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


  const planConversationRefreshed = await getSetting<boolean>("plan_conversation_first_metadata_refreshed_v1");
  if (!planConversationRefreshed) {
    const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === "plan");
    const [existing] = await db.select({ id: skills.id, author: skills.author, customized: skills.customized }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "plan")));
    if (def && existing?.author === "system" && existing.customized !== true) {
      await db.update(skills).set({
        description: def.description,
        category: def.category,
        activity: def.activity,
        process: def.process,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        checklist: def.checklist ?? [],
        version: def.version || "1.0",
        addToMemory: def.addToMemory ?? true,
        pinnedToContext: def.pinnedToContext ?? false,
        updatedAt: new Date(),
      }).where(eq(skills.id, existing.id));
      log.debug(`Refreshed conversation-first metadata/process for "plan"`);
    }
    await setSetting("plan_conversation_first_metadata_refreshed_v1", true);
  }


  const planQuarterlyRefreshed = await getSetting<boolean>("plan_quarterly_metadata_refreshed_v1");
  if (!planQuarterlyRefreshed) {
    const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === "plan");
    const [existing] = await db.select({ id: skills.id, author: skills.author, customized: skills.customized }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "plan")));
    if (def && existing?.author === "system" && existing.customized !== true) {
      await db.update(skills).set({
        description: def.description,
        category: def.category,
        activity: def.activity,
        process: def.process,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        checklist: def.checklist ?? [],
        version: def.version || "1.0",
        addToMemory: def.addToMemory ?? true,
        pinnedToContext: def.pinnedToContext ?? false,
        updatedAt: new Date(),
      }).where(eq(skills.id, existing.id));
      log.debug(`Refreshed quarterly metadata/process for "plan"`);
    }
    await setSetting("plan_quarterly_metadata_refreshed_v1", true);
  }


  const planDailyRefreshed = await getSetting<boolean>("plan_daily_metadata_refreshed_v1");
  if (!planDailyRefreshed) {
    const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === "plan");
    const [existing] = await db.select({ id: skills.id, author: skills.author, customized: skills.customized }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, "plan")));
    if (def && existing?.author === "system" && existing.customized !== true) {
      await db.update(skills).set({
        description: def.description,
        category: def.category,
        activity: def.activity,
        process: def.process,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        checklist: def.checklist ?? [],
        version: def.version || "1.0",
        addToMemory: def.addToMemory ?? true,
        pinnedToContext: def.pinnedToContext ?? false,
        updatedAt: new Date(),
      }).where(eq(skills.id, existing.id));
      log.debug(`Refreshed daily metadata/process for "plan"`);
    }
    await setSetting("plan_daily_metadata_refreshed_v1", true);
  }
  const metadataRefreshed = await getSetting<boolean>("parameterized_plan_reflect_metadata_refreshed_v1");
  if (!metadataRefreshed) {
    for (const name of ["plan", "reflect"]) {
      const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === name);
      if (!def) continue;
      const [existing] = await db.select({ id: skills.id, author: skills.author, customized: skills.customized }).from(skills).where(and(eq(skills.scope, "global"), eq(skills.name, name)));
      if (!existing || existing.author !== "system" || existing.customized === true) continue;
      await db.update(skills).set({
        description: def.description,
        category: def.category,
        activity: def.activity,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        checklist: def.checklist ?? [],
        version: def.version || "1.0",
        addToMemory: def.addToMemory ?? true,
        pinnedToContext: def.pinnedToContext ?? false,
        updatedAt: new Date(),
      }).where(eq(skills.id, existing.id));
      log.debug(`Refreshed parameterized skill metadata for "${name}"`);
    }
    await setSetting("parameterized_plan_reflect_metadata_refreshed_v1", true);
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
