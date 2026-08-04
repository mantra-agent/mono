import { randomBytes } from "crypto";
import { and, eq, ilike, inArray, isNull } from "drizzle-orm";
import { companies, companyIdentityKeys, persons, opportunities } from "@shared/schema";
import { db } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { visiblePersonPredicate, writablePersonPredicate } from "./person-vault-access";
import { createLogger } from "./log";
import { tagService } from "./tag-service";

const log = createLogger("CompanyStorage");
const companyScope = { scope: companies.scope, ownerUserId: companies.ownerUserId, accountId: companies.accountId };
const companyIdentityScope = {
  scope: companyIdentityKeys.scope,
  ownerUserId: companyIdentityKeys.ownerUserId,
  accountId: companyIdentityKeys.accountId,
};
const opportunityScope = { scope: opportunities.scope, ownerUserId: opportunities.ownerUserId, accountId: opportunities.accountId };
const personScope = { scope: persons.scope, ownerUserId: persons.ownerUserId, accountId: persons.accountId };

export interface Company {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  website?: string;
  industry?: string;
  location?: string;
  notes?: string;
  tags: string[];
  peopleCount?: number;
  opportunityCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type CompanyIdentityResolution =
  | { status: "resolved"; company: Company; matchedBy: "canonical_name" | "alias"; matchedValue: string }
  | { status: "unresolved"; normalizedInput: string }
  | { status: "ambiguous"; normalizedInput: string; candidateCompanyIds: string[] };

type IdentityOwnership = {
  scope: string;
  ownerUserId?: string | null;
  accountId?: string | null;
};

type DesiredIdentity = {
  kind: "canonical" | "alias";
  value: string;
  normalizedValue: string;
  source: "manual" | "rename";
};

function companyId(): string {
  return randomBytes(4).toString("hex");
}

export function normalizeCompanyIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDisplayValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function identityNamespace(ownership: IdentityOwnership): string {
  if (ownership.scope === "global") return "global";
  if (ownership.accountId) return `account:${ownership.accountId}`;
  if (ownership.ownerUserId) return `owner:${ownership.ownerUserId}`;
  return "system";
}

function desiredIdentities(name: string, aliases: unknown, previousName?: string): DesiredIdentity[] {
  const canonicalName = normalizeDisplayValue(name);
  const canonicalNormalized = normalizeCompanyIdentity(canonicalName);
  const desired = new Map<string, DesiredIdentity>();
  desired.set(canonicalNormalized, {
    kind: "canonical",
    value: canonicalName,
    normalizedValue: canonicalNormalized,
    source: "manual",
  });
  const values = Array.isArray(aliases) ? [...aliases] : [];
  if (previousName && normalizeCompanyIdentity(previousName) !== canonicalNormalized) values.push(previousName);
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = normalizeDisplayValue(raw);
    const normalizedValue = normalizeCompanyIdentity(value);
    if (!normalizedValue || desired.has(normalizedValue)) continue;
    desired.set(normalizedValue, {
      kind: "alias",
      value,
      normalizedValue,
      source: previousName && normalizedValue === normalizeCompanyIdentity(previousName) ? "rename" : "manual",
    });
  }
  return [...desired.values()];
}

function mapCompany(
  row: typeof companies.$inferSelect,
  aliases: string[] = [],
  peopleCount?: number,
  opportunityCount?: number,
): Company {
  return {
    id: row.id,
    name: row.name,
    aliases,
    description: row.description || undefined,
    website: row.website || undefined,
    industry: row.industry || undefined,
    location: row.location || undefined,
    notes: row.notes || undefined,
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
    peopleCount,
    opportunityCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class CompanyStorage {
  private async activeAliasesByCompany(companyIds: string[]): Promise<Map<string, string[]>> {
    const aliasesByCompany = new Map<string, string[]>();
    if (companyIds.length === 0) return aliasesByCompany;
    const principal = requireCurrentUserPrincipal();
    const rows = await db.select({
      companyId: companyIdentityKeys.companyId,
      value: companyIdentityKeys.value,
    }).from(companyIdentityKeys).where(combineWithVisibleScope(
      principal,
      companyIdentityScope,
      and(
        isNull(companyIdentityKeys.revokedAt),
        eq(companyIdentityKeys.kind, "alias"),
        inArray(companyIdentityKeys.companyId, companyIds),
      ),
    ));
    for (const row of rows) {
      const aliases = aliasesByCompany.get(row.companyId) ?? [];
      aliases.push(row.value);
      aliasesByCompany.set(row.companyId, aliases);
    }
    for (const aliases of aliasesByCompany.values()) aliases.sort((a, b) => a.localeCompare(b));
    return aliasesByCompany;
  }

  async list(query?: string): Promise<Company[]> {
    const principal = requireCurrentUserPrincipal();
    const identityCompanyIds = !query?.trim() ? [] : (await db.select({ companyId: companyIdentityKeys.companyId })
      .from(companyIdentityKeys)
      .where(combineWithVisibleScope(principal, companyIdentityScope, and(
        isNull(companyIdentityKeys.revokedAt),
        ilike(companyIdentityKeys.value, `%${query.trim()}%`),
      )))).map((row) => row.companyId);
    const predicate = !query?.trim()
      ? undefined
      : identityCompanyIds.length > 0
        ? inArray(companies.id, [...new Set(identityCompanyIds)])
        : eq(companies.id, "");
    const rows = await db.select().from(companies).where(combineWithVisibleScope(principal, companyScope, predicate));
    const [aliasesByCompany, visiblePeople, visibleOpportunities] = await Promise.all([
      this.activeAliasesByCompany(rows.map((row) => row.id)),
      db.select({ companyId: persons.companyId }).from(persons).where(visiblePersonPredicate(principal)),
      db.select({ companyId: opportunities.companyId }).from(opportunities).where(combineWithVisibleScope(principal, opportunityScope)),
    ]);
    const peopleCounts = new Map<string, number>();
    for (const person of visiblePeople) {
      if (person.companyId) peopleCounts.set(person.companyId, (peopleCounts.get(person.companyId) || 0) + 1);
    }
    const opportunityCounts = new Map<string, number>();
    for (const opportunity of visibleOpportunities) {
      if (opportunity.companyId) opportunityCounts.set(opportunity.companyId, (opportunityCounts.get(opportunity.companyId) || 0) + 1);
    }
    return rows
      .map((row) => mapCompany(
        row,
        aliasesByCompany.get(row.id) ?? [],
        peopleCounts.get(row.id) || 0,
        opportunityCounts.get(row.id) || 0,
      ))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Company | null> {
    const rows = await db.select().from(companies)
      .where(combineWithVisibleScope(requireCurrentUserPrincipal(), companyScope, eq(companies.id, id)))
      .limit(1);
    if (!rows[0]) return null;
    const [aliasesByCompany, members, linkedOpportunities] = await Promise.all([
      this.activeAliasesByCompany([id]),
      this.listPeople(id),
      this.listOpportunities(id),
    ]);
    return mapCompany(rows[0], aliasesByCompany.get(id) ?? [], members.length, linkedOpportunities.length);
  }

  async resolveIdentity(value: string): Promise<CompanyIdentityResolution> {
    const normalizedInput = normalizeCompanyIdentity(value);
    if (!normalizedInput) return { status: "unresolved", normalizedInput };
    const principal = requireCurrentUserPrincipal();
    const matches = await db.select({
      company: companies,
      kind: companyIdentityKeys.kind,
      matchedValue: companyIdentityKeys.value,
    })
      .from(companyIdentityKeys)
      .innerJoin(companies, eq(companyIdentityKeys.companyId, companies.id))
      .where(and(
        combineWithVisibleScope(principal, companyIdentityScope, and(
          eq(companyIdentityKeys.normalizedValue, normalizedInput),
          isNull(companyIdentityKeys.revokedAt),
        )),
        combineWithVisibleScope(principal, companyScope),
      ));
    const candidates = new Map(matches.map((match) => [match.company.id, match]));
    if (candidates.size === 0) return { status: "unresolved", normalizedInput };
    if (candidates.size > 1) {
      return { status: "ambiguous", normalizedInput, candidateCompanyIds: [...candidates.keys()].sort() };
    }
    const match = [...candidates.values()][0];
    const aliasesByCompany = await this.activeAliasesByCompany([match.company.id]);
    return {
      status: "resolved",
      company: mapCompany(match.company, aliasesByCompany.get(match.company.id) ?? []),
      matchedBy: match.kind === "canonical" ? "canonical_name" : "alias",
      matchedValue: match.matchedValue,
    };
  }

  async resolve(idOrName: string): Promise<Company | null> {
    const byId = await this.get(idOrName);
    if (byId) return byId;
    const resolution = await this.resolveIdentity(idOrName);
    return resolution.status === "resolved" ? resolution.company : null;
  }

  async create(input: Pick<Company, "name"> & Partial<Omit<Company, "id" | "name" | "createdAt" | "updatedAt">>): Promise<Company> {
    const name = normalizeDisplayValue(input.name);
    if (!name) throw new Error("Company name is required");
    const identities = desiredIdentities(name, input.aliases);
    const principal = requireCurrentUserPrincipal();
    const ownership = ownedInsertValues(principal, companyScope);
    const namespace = identityNamespace(ownership);
    const now = new Date();
    const id = companyId();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(companies).values({
          id,
          ...ownership,
          name,
          description: input.description?.trim() || null,
          website: input.website?.trim() || null,
          industry: input.industry?.trim() || null,
          location: input.location?.trim() || null,
          notes: input.notes?.trim() || null,
          tags: input.tags || [],
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(companyIdentityKeys).values(identities.map((identity) => ({
          companyId: id,
          ...identity,
          identityNamespace: namespace,
          ...ownedInsertValues(principal, companyIdentityScope),
          createdByUserId: principal.userId ?? undefined,
        })));
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("A company name or alias is already in use in this account");
      }
      throw error;
    }
    tagService.replaceEntityTags("company", id, name, input.tags || []).catch((err) =>
      log.warn("company tag sync failed", { id, error: err instanceof Error ? err.message : String(err) }),
    );
    return (await this.get(id))!;
  }

  async update(id: string, updates: Partial<Pick<Company, "name" | "aliases" | "description" | "website" | "industry" | "location" | "notes" | "tags">>): Promise<Company> {
    const current = await this.get(id);
    if (!current) throw new Error("Company not found");
    const nextName = updates.name === undefined ? current.name : normalizeDisplayValue(updates.name);
    if (!nextName) throw new Error("Company name is required");
    const nextAliases = updates.aliases === undefined ? current.aliases : updates.aliases;
    const identities = desiredIdentities(nextName, nextAliases, current.name);
    const desiredByNormalized = new Map(identities.map((identity) => [identity.normalizedValue, identity]));
    const principal = requireCurrentUserPrincipal();
    const now = new Date();

    try {
      await db.transaction(async (tx) => {
        const [companyRow] = await tx.select().from(companies)
          .where(combineWithWritableScope(principal, companyScope, eq(companies.id, id)))
          .limit(1);
        if (!companyRow) throw new Error("Company not writable");
        const namespace = identityNamespace(companyRow);
        const activeKeys = await tx.select().from(companyIdentityKeys)
          .where(combineWithWritableScope(principal, companyIdentityScope, and(
            eq(companyIdentityKeys.companyId, id),
            isNull(companyIdentityKeys.revokedAt),
          )));
        const replacedOrRemoved = activeKeys.filter((key) => {
          const desired = desiredByNormalized.get(key.normalizedValue);
          return !desired || desired.kind !== key.kind || desired.value !== key.value;
        });
        if (replacedOrRemoved.length > 0) {
          await tx.update(companyIdentityKeys)
            .set({ revokedAt: now, revokedByUserId: principal.userId ?? null })
            .where(combineWithWritableScope(
              principal,
              companyIdentityScope,
              inArray(companyIdentityKeys.id, replacedOrRemoved.map((key) => key.id)),
            ));
        }
        const retained = new Set(activeKeys
          .filter((key) => !replacedOrRemoved.some((replaced) => replaced.id === key.id))
          .map((key) => key.normalizedValue));
        const additions = identities.filter((identity) => !retained.has(identity.normalizedValue));
        if (additions.length > 0) {
          await tx.insert(companyIdentityKeys).values(additions.map((identity) => ({
            companyId: id,
            ...identity,
            identityNamespace: namespace,
            ...ownedInsertValues(principal, companyIdentityScope),
            createdByUserId: principal.userId ?? undefined,
          })));
        }
        const patch: Record<string, unknown> = { name: nextName, updatedAt: now };
        for (const field of ["description", "website", "industry", "location", "notes"] as const) {
          if (updates[field] !== undefined) patch[field] = updates[field]?.trim() || null;
        }
        if (updates.tags !== undefined) patch.tags = updates.tags;
        await tx.update(companies).set(patch)
          .where(combineWithWritableScope(principal, companyScope, eq(companies.id, id)));
        if (nextName !== current.name) {
          await tx.update(persons).set({ company: nextName, updatedAt: now })
            .where(combineWithWritableScope(principal, personScope, eq(persons.companyId, id)));
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("A company name or alias is already in use in this account");
      }
      throw error;
    }
    if (updates.tags !== undefined) {
      tagService.replaceEntityTags("company", id, nextName, updates.tags).catch((err) =>
        log.warn("company tag sync failed", { id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    await db.transaction(async (tx) => {
      await tx.update(persons).set({ companyId: null, company: null, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, personScope, eq(persons.companyId, id)));
      await tx.update(opportunities).set({ companyId: null, company: null, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, opportunityScope, eq(opportunities.companyId, id)));
      await tx.delete(companies).where(combineWithWritableScope(principal, companyScope, eq(companies.id, id)));
    });
    tagService.removeEntity("company", id).catch((err) =>
      log.warn("company tag cleanup failed", { id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  async listPeople(id: string) {
    return db.select({ id: persons.id, name: persons.name, role: persons.role, company: persons.company })
      .from(persons)
      .where(visiblePersonPredicate(requireCurrentUserPrincipal(), eq(persons.companyId, id)));
  }

  async listOpportunities(id: string) {
    const { opportunityStorage } = await import("./opportunity-storage");
    return opportunityStorage.listForCompany(id, requireCurrentUserPrincipal());
  }

  async addOpportunity(companyIdValue: string, opportunityId: number): Promise<void> {
    const company = await this.get(companyIdValue);
    if (!company) throw new Error("Company not found");
    const { opportunityStorage } = await import("./opportunity-storage");
    const row = await opportunityStorage.setCompany(opportunityId, company.id, requireCurrentUserPrincipal());
    if (!row) throw new Error("Opportunity not found or not writable");
  }

  async removeOpportunity(companyIdValue: string, opportunityId: number): Promise<void> {
    const { opportunityStorage } = await import("./opportunity-storage");
    const current = await opportunityStorage.get(opportunityId, requireCurrentUserPrincipal());
    if (!current || current.companyId !== companyIdValue) throw new Error("Opportunity is not linked to this company");
    await opportunityStorage.setCompany(opportunityId, null, requireCurrentUserPrincipal());
  }

  async addPerson(companyIdValue: string, personId: string): Promise<void> {
    const company = await this.get(companyIdValue);
    if (!company) throw new Error("Company not found");
    const rows = await db.update(persons).set({ companyId: company.id, company: company.name, updatedAt: new Date() })
      .where(writablePersonPredicate(requireCurrentUserPrincipal(), eq(persons.id, personId))).returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person not found or not writable");
  }

  async removePerson(companyIdValue: string, personId: string): Promise<void> {
    const rows = await db.update(persons).set({ companyId: null, company: null, updatedAt: new Date() })
      .where(writablePersonPredicate(requireCurrentUserPrincipal(), and(eq(persons.id, personId), eq(persons.companyId, companyIdValue))))
      .returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person is not linked to this company");
  }
}

export const companyStorage = new CompanyStorage();
