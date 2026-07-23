import { db, pool } from "./db";
import { eq, desc, and, inArray } from "drizzle-orm";
import {
  opportunities,
  vaults,
  opportunityArtifacts,
  opportunitySkills,
  opportunityInteractions,
  execSkills,
  computeEV,
  type OpportunityRow,
  type InsertOpportunity,
  type OpportunityWithSkills,
  type OpportunityArtifactRow,
  type ArtifactKind,
  type CreateOpportunityInteractionInput,
  type UpdateOpportunityInteractionInput,
  type OpportunityInteractionActivity,
} from "@shared/schema";
import { createLogger } from "./log";
import { getDateInTimezone } from "./timezone";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import type { Interaction } from "./people-storage";

const log = createLogger("OpportunityStorage");
const opportunityScopeColumns = { scope: opportunities.scope, ownerUserId: opportunities.ownerUserId, accountId: opportunities.accountId };
const interactionLinkScopeColumns = { scope: opportunityInteractions.scope, ownerUserId: opportunityInteractions.ownerUserId, accountId: opportunityInteractions.accountId };

function opportunityUserId(principal: Principal): string {
  if (!principal.userId) throw Object.assign(new Error("User principal required"), { status: 401 });
  return principal.userId;
}

function interactionReference(personId: string, interactionId: string): string {
  return `@interaction:${encodeURIComponent(personId)}~${encodeURIComponent(interactionId)}`;
}


let schemaMigrated = false;

// ── Opportunity → People follow-up sync ─────────────────────────
// When an opportunity has followUpBy + a linked person (champion or contact),
// auto-create/update an interaction on that person with responseOwed so the
// people agenda system surfaces the follow-up obligation.

const OPP_FOLLOWUP_TAG_PREFIX = "opp-followup:";

interface FollowUpSyncInput {
  opportunityId: number;
  title: string;
  followUpBy: string | null;
  followUpNote: string | null;
  championPersonId: string | null;
  contactPersonId: string | null;
  /** Previous state for diffing on update */
  previous?: {
    followUpBy: string | null;
    championPersonId: string | null;
    contactPersonId: string | null;
  };
}

async function syncOpportunityFollowUp(input: FollowUpSyncInput): Promise<void> {
  // Lazy import to avoid circular dependency at module init
  const { peopleStorage } = await import("./people-storage");
  const tag = `${OPP_FOLLOWUP_TAG_PREFIX}${input.opportunityId}`;

  // Determine which person IDs are currently linked
  const currentPersonIds = new Set<string>();
  if (input.championPersonId) currentPersonIds.add(input.championPersonId);
  if (input.contactPersonId) currentPersonIds.add(input.contactPersonId);

  // Determine which person IDs were previously linked (for cleanup)
  const previousPersonIds = new Set<string>();
  if (input.previous?.championPersonId) previousPersonIds.add(input.previous.championPersonId);
  if (input.previous?.contactPersonId) previousPersonIds.add(input.previous.contactPersonId);

  // Person IDs that were removed — clear their follow-up
  const removedPersonIds = [...previousPersonIds].filter(id => !currentPersonIds.has(id));

  // Clear responseOwed on removed persons
  for (const personId of removedPersonIds) {
    try {
      const person = await peopleStorage.getPerson(personId);
      if (!person) continue;
      const existing = person.interactions.find(ix => ix.tags?.includes(tag));
      if (existing && existing.responseOwed) {
        await peopleStorage.updateInteraction(personId, existing.id, { responseOwed: false });
        log.debug(`cleared follow-up on removed person=${personId} opp=${input.opportunityId}`);
      }
    } catch (err) {
      log.warn(`failed to clear follow-up on person=${personId}: ${err}`);
    }
  }

  // Sync current person IDs
  for (const personId of currentPersonIds) {
    try {
      const person = await peopleStorage.getPerson(personId);
      if (!person) {
        log.debug(`skip follow-up sync: person=${personId} not found`);
        continue;
      }

      const existing = person.interactions.find(ix => ix.tags?.includes(tag));
      const summary = `Follow up: ${input.title}${input.followUpNote ? ` — ${input.followUpNote}` : ""}`;

      if (input.followUpBy) {
        if (existing) {
          // Update existing interaction
          await peopleStorage.updateInteraction(personId, existing.id, {
            summary,
            responseOwed: true,
            responseDueBy: input.followUpBy,
          });
          log.debug(`updated follow-up interaction on person=${personId} opp=${input.opportunityId} dueBy=${input.followUpBy}`);
        } else {
          // Create new interaction
          await peopleStorage.addInteraction(personId, {
            date: getDateInTimezone(),
            type: "note",
            summary,
            responseOwed: true,
            responseDueBy: input.followUpBy,
            tags: [tag],
          });
          log.debug(`created follow-up interaction on person=${personId} opp=${input.opportunityId} dueBy=${input.followUpBy}`);
        }
      } else if (existing && existing.responseOwed) {
        // followUpBy was cleared — clear the obligation
        await peopleStorage.updateInteraction(personId, existing.id, { responseOwed: false });
        log.debug(`cleared follow-up on person=${personId} opp=${input.opportunityId} (followUpBy removed)`);
      }
    } catch (err) {
      log.warn(`failed to sync follow-up on person=${personId}: ${err}`);
    }
  }
}

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${message})`);
      await migrateOpportunitySchema();
      schemaMigrated = true;
      try {
        return await operation();
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log.warn(`auto-heal: retry failed after migration (${retryMsg})`);
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function migrateOpportunitySchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        vault_id TEXT REFERENCES vaults(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'discovered',
        probability REAL NOT NULL DEFAULT 0.05,
        is_full_time BOOLEAN NOT NULL DEFAULT false,
        hours_per_week INTEGER,
        time_commitment_period TEXT DEFAULT 'week',
        time_horizon_months INTEGER,
        ev_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
        computed_ev REAL,
        contact_person_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_signal_id TEXT,
        required_skills TEXT[] NOT NULL DEFAULT '{}'::text[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Auto-heal columns
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS is_full_time BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS hours_per_week INTEGER;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS time_commitment_period TEXT DEFAULT 'week';
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS time_horizon_months INTEGER;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS contact_person_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_signal_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS required_skills TEXT[] NOT NULL DEFAULT '{}'::text[];
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS company TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS company_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS next_steps TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS priority TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS jd_text TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS job_url TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS champion_person_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS follow_up_by TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS follow_up_note TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS account_id TEXT;
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS vault_id TEXT;
      UPDATE opportunities SET owner_user_id = user_id WHERE owner_user_id IS NULL;

      DO $
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'opportunities_vault_id_fkey'
            AND conrelid = 'opportunities'::regclass
        ) THEN
          ALTER TABLE opportunities
            ADD CONSTRAINT opportunities_vault_id_fkey
            FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE SET NULL;
        END IF;
      END
      $;

      CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
      CREATE INDEX IF NOT EXISTS idx_opportunities_type ON opportunities(type);
      CREATE INDEX IF NOT EXISTS idx_opportunities_user ON opportunities(user_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_scope_owner ON opportunities(scope, owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_vault_id ON opportunities(vault_id);
      CREATE INDEX IF NOT EXISTS idx_opportunities_company_id ON opportunities(company_id);

      CREATE TABLE IF NOT EXISTS opportunity_interactions (
        id SERIAL PRIMARY KEY,
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_opportunity_interaction UNIQUE(opportunity_id, person_id, interaction_id)
      );
      CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_opportunity ON opportunity_interactions(opportunity_id);
      CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_interaction ON opportunity_interactions(person_id, interaction_id);
      CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_scope_owner ON opportunity_interactions(scope, owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_account ON opportunity_interactions(account_id);

      CREATE TABLE IF NOT EXISTS opportunity_artifacts (
        id SERIAL PRIMARY KEY,
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        library_page_id TEXT NOT NULL,
        session_id TEXT,
        docx_file_name TEXT,
        generated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_opportunity_artifact_kind UNIQUE(opportunity_id, kind)
      );

      CREATE TABLE IF NOT EXISTS opportunity_skills (
        id SERIAL PRIMARY KEY,
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES exec_skills(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_opportunity_skill UNIQUE(opportunity_id, skill_id)
      );
    `);
    log.debug("opportunity schema migration complete");
  } finally {
    client.release();
  }
}

// ── Storage Class ──────────────────────────────────────────────────
class OpportunityStorage {
  async list(principal: Principal, filters?: { status?: string; type?: string }): Promise<OpportunityRow[]> {
    return autoHeal(async () => {
      const conditions = [];
      if (filters?.status) conditions.push(eq(opportunities.status, filters.status));
      if (filters?.type) conditions.push(eq(opportunities.type, filters.type));
      return db.select().from(opportunities)
        .where(combineWithVisibleScope(principal, opportunityScopeColumns, conditions.length ? and(...conditions) : undefined))
        .orderBy(desc(opportunities.updatedAt));
    });
  }

  async get(id: number, principal: Principal): Promise<OpportunityRow | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(opportunities).where(
        combineWithVisibleScope(principal, opportunityScopeColumns, eq(opportunities.id, id)),
      );
      return row;
    });
  }

  async create(principal: Principal, data: InsertOpportunity): Promise<OpportunityRow> {
    return autoHeal(async () => {
      await this.assertAssignableVault(data.vaultId, principal);
      const normalized = await this.normalizeCompany(data);
      const ev = computeEV(normalized.type, (normalized.evInputs || {}) as Record<string, any>, normalized.probability ?? 0.05, normalized.hoursPerWeek);
      const [row] = await db.insert(opportunities).values({
        ...normalized,
        userId: opportunityUserId(principal),
        ...ownedInsertValues(principal, opportunityScopeColumns),
        evInputs: normalized.evInputs || {},
        computedEv: ev,
      }).returning();
      log.debug(`create opportunity id=${row.id} title="${row.title}" ev=${ev.toFixed(0)}`);
      syncOpportunityFollowUp({
        opportunityId: row.id, title: row.title, followUpBy: row.followUpBy, followUpNote: row.followUpNote,
        championPersonId: row.championPersonId, contactPersonId: row.contactPersonId,
      }).catch(err => log.warn(`follow-up sync failed for new opp=${row.id}: ${err}`));
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertOpportunity>, principal: Principal): Promise<OpportunityRow | undefined> {
    return autoHeal(async () => {
      const existing = await this.get(id, principal);
      if (!existing) return undefined;
      await this.assertAssignableVault(updates.vaultId, principal);
      const normalized = await this.normalizeCompany(updates);
      const merged = { ...existing, ...normalized };
      const needsRecompute = normalized.type !== undefined || normalized.evInputs !== undefined || normalized.probability !== undefined || normalized.hoursPerWeek !== undefined;
      const patch: Record<string, unknown> = { ...normalized, updatedAt: new Date() };
      if (needsRecompute) patch.computedEv = computeEV(merged.type, (merged.evInputs || {}) as Record<string, any>, merged.probability ?? 0.05, merged.hoursPerWeek);
      const [row] = await db.update(opportunities).set(patch).where(
        combineWithWritableScope(principal, opportunityScopeColumns, eq(opportunities.id, id)),
      ).returning();
      if (row && (updates.followUpBy !== undefined || updates.championPersonId !== undefined || updates.contactPersonId !== undefined || updates.followUpNote !== undefined || updates.title !== undefined)) {
        syncOpportunityFollowUp({
          opportunityId: row.id, title: row.title, followUpBy: row.followUpBy, followUpNote: row.followUpNote,
          championPersonId: row.championPersonId, contactPersonId: row.contactPersonId,
          previous: { followUpBy: existing.followUpBy, championPersonId: existing.championPersonId, contactPersonId: existing.contactPersonId },
        }).catch(err => log.warn(`follow-up sync failed for opp=${id}: ${err}`));
      }
      return row;
    });
  }

  private async assertAssignableVault(vaultId: string | null | undefined, principal: Principal): Promise<void> {
    if (vaultId === undefined || vaultId === null) return;
    if (!principal.accountId) throw Object.assign(new Error("User account required"), { status: 401 });
    const [vault] = await db.select({ id: vaults.id }).from(vaults).where(and(
      eq(vaults.id, vaultId),
      eq(vaults.accountId, principal.accountId),
      eq(vaults.isArchived, false),
    )).limit(1);
    if (!vault) throw Object.assign(new Error("Opportunity Vault must be live and belong to the active account"), { status: 400 });
  }

  async setVault(id: number, vaultId: string | null, principal: Principal): Promise<OpportunityRow | undefined> {
    return this.update(id, { vaultId }, principal);
  }

  private async normalizeCompany<T extends Partial<InsertOpportunity>>(data: T): Promise<T> {
    if (data.companyId === undefined) return data;
    if (!data.companyId) return { ...data, companyId: null, company: null };
    const { companyStorage } = await import("./company-storage");
    const company = await companyStorage.get(data.companyId);
    if (!company) throw Object.assign(new Error("Company not found"), { status: 400 });
    return { ...data, companyId: company.id, company: company.name };
  }

  async listForCompany(companyId: string, principal: Principal): Promise<OpportunityRow[]> {
    return autoHeal(() => db.select().from(opportunities).where(
      combineWithVisibleScope(principal, opportunityScopeColumns, eq(opportunities.companyId, companyId)),
    ).orderBy(desc(opportunities.updatedAt)));
  }

  async setCompany(id: number, companyId: string | null, principal: Principal): Promise<OpportunityRow | undefined> {
    return this.update(id, { companyId }, principal);
  }

  async delete(id: number, principal: Principal): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(opportunities).where(
        combineWithWritableScope(principal, opportunityScopeColumns, eq(opportunities.id, id)),
      ).returning();
      return !!row;
    });
  }

  // ── Activity associations ─────────────────────────────────────

  async listActivities(opportunityId: number, principal: Principal): Promise<OpportunityInteractionActivity[]> {
    const opportunity = await this.get(opportunityId, principal);
    if (!opportunity) throw Object.assign(new Error("Opportunity not found"), { status: 404 });
    const links = await autoHeal(() => db.select().from(opportunityInteractions).where(
      combineWithVisibleScope(principal, interactionLinkScopeColumns, eq(opportunityInteractions.opportunityId, opportunityId)),
    ).orderBy(desc(opportunityInteractions.createdAt)));
    const { peopleStorage } = await import("./people-storage");
    const people = await peopleStorage.getPeopleByIds([...new Set(links.map(link => link.personId))]);
    const byPerson = new Map(people.map(person => [person.id, person]));
    const seen = new Set<string>();
    const result: OpportunityInteractionActivity[] = [];
    for (const link of links) {
      const key = `${link.personId}:${link.interactionId}`;
      if (seen.has(key)) continue;
      const person = byPerson.get(link.personId);
      const interaction = person?.interactions.find(item => item.id === link.interactionId);
      if (!person || !interaction) continue;
      seen.add(key);
      result.push({
        associationId: link.id, opportunityId, personId: person.id, personName: person.name,
        interaction, reference: interactionReference(person.id, interaction.id), createdAt: link.createdAt,
      });
    }
    return result.sort((a, b) => new Date(b.interaction.date).getTime() - new Date(a.interaction.date).getTime());
  }

  async createOrLinkActivity(opportunityId: number, input: CreateOpportunityInteractionInput, principal: Principal): Promise<OpportunityInteractionActivity> {
    const opportunity = await this.get(opportunityId, principal);
    if (!opportunity) throw Object.assign(new Error("Opportunity not found"), { status: 404 });
    const { peopleStorage } = await import("./people-storage");
    const person = await peopleStorage.getPerson(input.personId);
    if (!person) throw Object.assign(new Error("Person not found"), { status: 404 });
    let interaction: Interaction | null = null;
    if (input.interactionId) {
      interaction = person.interactions.find(item => item.id === input.interactionId) ?? null;
      if (!interaction) throw Object.assign(new Error("Interaction not found"), { status: 404 });
    } else {
      const updated = await peopleStorage.addInteraction(input.personId, {
        date: input.date ?? getDateInTimezone(),
        type: input.type ?? "note",
        summary: input.summary!,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.meaningfulness !== undefined ? { meaningfulness: input.meaningfulness } : {}),
        ...(input.responseOwed !== undefined ? { responseOwed: input.responseOwed } : {}),
        ...(input.responseDueBy ? { responseDueBy: input.responseDueBy } : {}),
        ...(input.capitalImpact !== undefined ? { capitalImpact: input.capitalImpact } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      });
      interaction = updated.interactions.at(-1) ?? null;
      if (!interaction) throw new Error("Interaction creation failed");
    }
    const [link] = await autoHeal(() => db.insert(opportunityInteractions).values({
      opportunityId, personId: input.personId, interactionId: interaction!.id,
      ...ownedInsertValues(principal, interactionLinkScopeColumns),
    }).onConflictDoUpdate({
      target: [opportunityInteractions.opportunityId, opportunityInteractions.personId, opportunityInteractions.interactionId],
      set: { personId: input.personId },
    }).returning());
    return {
      associationId: link.id, opportunityId, personId: person.id, personName: person.name,
      interaction, reference: interactionReference(person.id, interaction.id), createdAt: link.createdAt,
    };
  }

  async updateActivity(opportunityId: number, associationId: number, updates: UpdateOpportunityInteractionInput, principal: Principal): Promise<OpportunityInteractionActivity | undefined> {
    const opportunity = await this.get(opportunityId, principal);
    if (!opportunity) return undefined;
    const [link] = await db.select().from(opportunityInteractions).where(
      combineWithWritableScope(principal, interactionLinkScopeColumns, and(eq(opportunityInteractions.id, associationId), eq(opportunityInteractions.opportunityId, opportunityId))),
    );
    if (!link) return undefined;
    const { peopleStorage } = await import("./people-storage");
    const person = await peopleStorage.updateInteraction(link.personId, link.interactionId, updates as Partial<Interaction>);
    const interaction = person.interactions.find(item => item.id === link.interactionId);
    if (!interaction) return undefined;
    return { associationId: link.id, opportunityId, personId: person.id, personName: person.name, interaction, reference: interactionReference(person.id, interaction.id), createdAt: link.createdAt };
  }

  async unlinkActivity(opportunityId: number, associationId: number, principal: Principal): Promise<boolean> {
    const opportunity = await this.get(opportunityId, principal);
    if (!opportunity) return false;
    const [link] = await db.delete(opportunityInteractions).where(
      combineWithWritableScope(principal, interactionLinkScopeColumns, and(eq(opportunityInteractions.id, associationId), eq(opportunityInteractions.opportunityId, opportunityId))),
    ).returning();
    return !!link;
  }

  // ── Artifact Slots ─────────────────────────────────────────────

  /**
   * Upsert the artifact slot for (opportunityId, kind). Keyed on the
   * unique constraint so regeneration updates the existing slot row
   * (same Library page identity, fresh session + timestamp).
   */
  async upsertArtifact(
    opportunityId: number,
    kind: ArtifactKind,
    data: { libraryPageId: string; sessionId?: string | null },
  ): Promise<OpportunityArtifactRow> {
    return autoHeal(async () => {
      const [row] = await db.insert(opportunityArtifacts).values({
        opportunityId,
        kind,
        libraryPageId: data.libraryPageId,
        sessionId: data.sessionId ?? null,
        generatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [opportunityArtifacts.opportunityId, opportunityArtifacts.kind],
        set: {
          libraryPageId: data.libraryPageId,
          sessionId: data.sessionId ?? null,
          generatedAt: new Date(),
          updatedAt: new Date(),
        },
      }).returning();
      log.debug(`upsert artifact opportunity=${opportunityId} kind=${kind} page=${data.libraryPageId}`);
      return row;
    });
  }

  async getArtifacts(opportunityId: number): Promise<OpportunityArtifactRow[]> {
    return autoHeal(async () => {
      return db.select().from(opportunityArtifacts)
        .where(eq(opportunityArtifacts.opportunityId, opportunityId));
    });
  }

  async getArtifact(opportunityId: number, kind: ArtifactKind): Promise<OpportunityArtifactRow | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(opportunityArtifacts).where(
        and(
          eq(opportunityArtifacts.opportunityId, opportunityId),
          eq(opportunityArtifacts.kind, kind),
        ),
      );
      return row;
    });
  }

  /** Delete an artifact slot. Returns true if a row was actually removed. */
  async deleteArtifact(opportunityId: number, kind: ArtifactKind): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(opportunityArtifacts)
        .where(and(
          eq(opportunityArtifacts.opportunityId, opportunityId),
          eq(opportunityArtifacts.kind, kind),
        )).returning();
      log.debug(`delete artifact opportunity=${opportunityId} kind=${kind} found=${!!row}`);
      return !!row;
    });
  }

  /** Record the rendered DOCX filename on an existing slot. */
  async setArtifactDocx(opportunityId: number, kind: ArtifactKind, docxFileName: string): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.update(opportunityArtifacts)
        .set({ docxFileName, updatedAt: new Date() })
        .where(and(
          eq(opportunityArtifacts.opportunityId, opportunityId),
          eq(opportunityArtifacts.kind, kind),
        )).returning();
      log.debug(`set artifact docx opportunity=${opportunityId} kind=${kind} file=${docxFileName} found=${!!row}`);
      return !!row;
    });
  }

  // ── Skill Linking ──────────────────────────────────────────────

  async linkSkill(opportunityId: number, skillId: number): Promise<void> {
    return autoHeal(async () => {
      await db.insert(opportunitySkills).values({ opportunityId, skillId })
        .onConflictDoNothing();
      log.debug(`linked skill ${skillId} to opportunity ${opportunityId}`);
    });
  }

  async unlinkSkill(opportunityId: number, skillId: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(opportunitySkills).where(
        and(
          eq(opportunitySkills.opportunityId, opportunityId),
          eq(opportunitySkills.skillId, skillId),
        ),
      ).returning();
      log.debug(`unlinked skill ${skillId} from opportunity ${opportunityId} found=${!!row}`);
      return !!row;
    });
  }

  async getSkillsForOpportunity(opportunityId: number): Promise<Array<{
    id: number; name: string; category: string | null;
    skillType: string | null; proficiency: string | null; energyLevel: string | null;
  }>> {
    return autoHeal(async () => {
      const rows = await db.select({
        id: execSkills.id,
        name: execSkills.name,
        category: execSkills.category,
        skillType: execSkills.skillType,
        proficiency: execSkills.proficiency,
        energyLevel: execSkills.energyLevel,
      })
        .from(opportunitySkills)
        .innerJoin(execSkills, eq(opportunitySkills.skillId, execSkills.id))
        .where(eq(opportunitySkills.opportunityId, opportunityId));
      return rows;
    });
  }

  async getOpportunitiesForSkill(skillId: number): Promise<OpportunityRow[]> {
    return autoHeal(async () => {
      const rows = await db.select({
        opportunity: opportunities,
      })
        .from(opportunitySkills)
        .innerJoin(opportunities, eq(opportunitySkills.opportunityId, opportunities.id))
        .where(eq(opportunitySkills.skillId, skillId));
      return rows.map(r => r.opportunity);
    });
  }

  /** List with linked skills eagerly loaded */
  async listWithSkills(principal: Principal, filters?: { status?: string; type?: string }): Promise<OpportunityWithSkills[]> {
    return autoHeal(async () => {
      const opps = await this.list(principal, filters);
      if (opps.length === 0) return [];

      // Batch-load all linked skills for these opportunities
      const oppIds = opps.map(o => o.id);
      const allLinks = await db.select({
        opportunityId: opportunitySkills.opportunityId,
        id: execSkills.id,
        name: execSkills.name,
        category: execSkills.category,
        skillType: execSkills.skillType,
        proficiency: execSkills.proficiency,
        energyLevel: execSkills.energyLevel,
      })
        .from(opportunitySkills)
        .innerJoin(execSkills, eq(opportunitySkills.skillId, execSkills.id))
        .where(inArray(opportunitySkills.opportunityId, oppIds));

      // Group by opportunity ID
      const byOpp = new Map<number, OpportunityWithSkills["linkedSkills"]>();
      for (const link of allLinks) {
        const arr = byOpp.get(link.opportunityId) || [];
        arr.push({
          id: link.id,
          name: link.name,
          category: link.category,
          skillType: link.skillType,
          proficiency: link.proficiency,
          energyLevel: link.energyLevel,
        });
        byOpp.set(link.opportunityId, arr);
      }

      return opps.map(o => ({
        ...o,
        linkedSkills: byOpp.get(o.id) || [],
      }));
    });
  }

  /** Get single opportunity with linked skills */
  async getWithSkills(id: number, principal: Principal): Promise<OpportunityWithSkills | undefined> {
    return autoHeal(async () => {
      const opp = await this.get(id, principal);
      if (!opp) return undefined;
      const linkedSkills = await this.getSkillsForOpportunity(id);
      return { ...opp, linkedSkills };
    });
  }
}

export const opportunityStorage = new OpportunityStorage();
