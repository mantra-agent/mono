import { createLogger } from "./log";
import { db } from "./db";
import { skills, libraryPages, personas, skillPersonaPreferences } from "@shared/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { BUILTIN_SKILL_DEFAULTS } from "./skill-defaults";
import * as fs from "fs";
import * as path from "path";

const log = createLogger("SkillSeed");

const PROMPT_NAME_TO_SKILL: Record<string, string> = {
  "introspect": "reflect",
  "monthly-reflect": "reflect",
};

const SKILL_RENAMES: Record<string, string> = {
  "monthly-reflect": "reflect",
  "sleep-cycle": "memory-sleep",
  "memory-sleep": "sleep",
  "introspect": "reflect",
  "reflect-daily": "reflect",
  "reflect-monthly": "reflect",
  "reflect-quarterly": "reflect",
  "reflect-annual": "reflect",
  "plan-weekly": "plan",
  "plan-monthly": "plan",
  "idea-generation": "ideate",
  "landscape-scan": "scan",
  "opportunity-research": "research",
  "council-advocate": "advocate",
  "coaching-model-1-0": "coach",
  "news-curation": "curate",
  "reliability-sentinel": "sentry",
  "security-sentinel": "guard",
};

export async function migrateSkillRenames(): Promise<void> {
  for (const [oldName, newName] of Object.entries(SKILL_RENAMES)) {
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, oldName));
    if (existing) {
      const [conflict] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, newName));
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
  "scan": "Operator",
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

function builtinSkillDefinitionPatch(def: (typeof BUILTIN_SKILL_DEFAULTS)[number]) {
  return {
    description: def.description,
    category: def.category,
    activity: def.activity,
    process: def.process,
    whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
    outputSpec: def.outputSpec ?? "See process instructions",
    checklist: def.checklist ?? [],
    version: def.version || "1.0",
    author: def.author || "system",
    status: "active",
    addToMemory: def.addToMemory ?? true,
    pinnedToContext: def.pinnedToContext ?? false,
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
          .where(eq(skills.name, ""));
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

      let [existing] = await db
        .select({
          id: skills.id,
          author: skills.author,
          customized: skills.customized,
          version: skills.version,
        })
        .from(skills)
        .where(eq(skills.name, def.name));

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
              author: skills.author,
              customized: skills.customized,
              version: skills.version,
            })
            .from(skills)
            .where(eq(skills.name, def.name));
          if (!existing) break;
        }
        preserved++;
        continue;
      }

      await db.insert(skills).values({
        name: def.name,
        description: def.description,
        category: def.category,
        activity: def.activity,
        process: def.process,
        whenToUse: def.whenToUse ?? `Used for ${def.category} operations`,
        outputSpec: def.outputSpec ?? "See process instructions",
        qualityCriteria: "",
        status: "active",
        author: def.author || "system",
        version: defVersion,
        addToMemory: def.addToMemory ?? true,
        ...(def.checklist !== undefined && { checklist: def.checklist }),
        budgetBehavior: null,
        pinnedToContext: def.pinnedToContext ?? false,
      });
      inserted++;
    } catch (err: any) {
      if (err.code === "23505") {
        preserved++;
      } else {
        errored++;
        log.error(`Failed to bootstrap skill ${def.name}: ${err.message} (code: ${err.code})`);
      }
    }
  }

  log.debug(`Skill bootstrap complete: ${inserted} inserted, ${preserved} existing-preserved, ${errored} errors (total defaults: ${BUILTIN_SKILL_DEFAULTS.length})`);
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
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, skillName));
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
  const rows = await db.select({ name: skills.name }).from(skills);
  const existing = new Set(rows.map(r => r.name));
  const required = BUILTIN_SKILL_DEFAULTS.map(d => d.name);
  const missing = required.filter(n => !existing.has(n));
  if (missing.length > 0) {
    log.error(`Missing required skills (${missing.length}): ${missing.join(", ")}`);
  } else {
    log.debug(`All ${required.length} required skills verified`);
  }
}

export async function migrateSkillProcessToToolBased(): Promise<void> {
  const skillsToMigrate: string[] = [];
  for (const name of skillsToMigrate) {
    const [existing] = await db.select({ id: skills.id, process: skills.process }).from(skills).where(eq(skills.name, name));
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
    const [existing] = await db.select({ id: skills.id, author: skills.author, status: skills.status }).from(skills).where(eq(skills.name, name));
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
      .where(eq(skills.name, "autonomy"));
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

export async function migrateDailyBriefCanonicalMeetingPrep(): Promise<void> {
  const [existing] = await db
    .select({ id: skills.id, author: skills.author, customized: skills.customized, version: skills.version, process: skills.process })
    .from(skills)
    .where(eq(skills.name, "brief-daily"));
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
    const [existing] = await db.select({ id: skills.id, process: skills.process }).from(skills).where(eq(skills.name, name));
    if (!existing) continue;
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
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, "plan"));
    if (def && existing) {
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
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, "plan"));
    if (def && existing) {
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
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, "plan"));
    if (def && existing) {
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
      if (!existing) continue;
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

export async function resetSkillToDefault(skillName: string): Promise<boolean> {
  const def = BUILTIN_SKILL_DEFAULTS.find(d => d.name === skillName);
  if (!def) return false;

  const [existing] = await db
    .select({ id: skills.id, author: skills.author })
    .from(skills)
    .where(eq(skills.name, skillName));
  if (!existing || existing.author !== "system") return false;

  await db.update(skills).set({
    ...builtinSkillDefinitionPatch(def),
    customized: false,
  }).where(eq(skills.id, existing.id));

  log.debug(`Reset skill "${skillName}" to default`);
  return true;
}

export async function deleteZombieSkills(): Promise<void> {
  const { getSetting, setSetting } = await import("./system-settings");

  const deletedV1 = await getSetting<boolean>("zombie_skills_deleted_v1");
  if (!deletedV1) {
    const zombieNames = ["ooda-decide", "ooda-orient", "tactical-decide"];
    let count = 0;

    for (const name of zombieNames) {
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
      const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
      if (existing) {
        await db.delete(skills).where(eq(skills.id, existing.id));
        log.debug(`Deleted retired autonomy predecessor skill "${name}" id=${existing.id}`);
        countV13++;
      }
    }

    const blankAutonomyRows = await db
      .select({ id: skills.id, description: skills.description })
      .from(skills)
      .where(eq(skills.name, ""));

    for (const row of blankAutonomyRows) {
      if (row.description?.includes("autonomous scan-and-execute loop")) {
        const [autonomy] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, "autonomy"));
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
  const emptyNameRows = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, ""));
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
    const [existing] = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
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
  const skillName = PROMPT_NAME_TO_SKILL[name] || name;
  const { storage } = await import("./storage");
  const skill = await storage.getSkillByName(skillName);
  if (skill) return skill.process;
  throw new Error(`Required skill not found in DB: "${name}". Runnable skills must be seeded before use.`);
}

export async function getSkillEntry(name: string): Promise<{ process: string; activity: string }> {
  const skillName = PROMPT_NAME_TO_SKILL[name] || name;
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
