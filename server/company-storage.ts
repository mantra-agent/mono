import { randomBytes } from "crypto";
import { and, eq, ilike } from "drizzle-orm";
import { companies, persons, opportunities } from "@shared/schema";
import { db } from "./db";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { visiblePersonPredicate, writablePersonPredicate } from "./person-vault-access";

const companyScope = { scope: companies.scope, ownerUserId: companies.ownerUserId, accountId: companies.accountId };
const opportunityScope = { scope: opportunities.scope, ownerUserId: opportunities.ownerUserId, accountId: opportunities.accountId };
const personScope = { scope: persons.scope, ownerUserId: persons.ownerUserId, accountId: persons.accountId };

export interface Company {
  id: string;
  name: string;
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

function companyId(): string {
  return randomBytes(4).toString("hex");
}

function mapCompany(row: typeof companies.$inferSelect, peopleCount?: number, opportunityCount?: number): Company {
  return {
    id: row.id,
    name: row.name,
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
  async list(query?: string): Promise<Company[]> {
    const principal = getCurrentPrincipalOrSystem();
    const predicate = query?.trim() ? ilike(companies.name, `%${query.trim()}%`) : undefined;
    const rows = await db.select().from(companies).where(combineWithVisibleScope(principal, companyScope, predicate));
    const visiblePeople = await db.select({ companyId: persons.companyId }).from(persons).where(visiblePersonPredicate(principal));
    const counts = new Map<string, number>();
    for (const person of visiblePeople) {
      if (person.companyId) counts.set(person.companyId, (counts.get(person.companyId) || 0) + 1);
    }
    const visibleOpportunities = await db.select({ companyId: opportunities.companyId }).from(opportunities).where(combineWithVisibleScope(principal, opportunityScope));
    const opportunityCounts = new Map<string, number>();
    for (const opportunity of visibleOpportunities) {
      if (opportunity.companyId) opportunityCounts.set(opportunity.companyId, (opportunityCounts.get(opportunity.companyId) || 0) + 1);
    }
    return rows.map(row => mapCompany(row, counts.get(row.id) || 0, opportunityCounts.get(row.id) || 0)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Company | null> {
    const rows = await db.select().from(companies).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), companyScope, eq(companies.id, id))).limit(1);
    if (!rows[0]) return null;
    const [members, linkedOpportunities] = await Promise.all([this.listPeople(id), this.listOpportunities(id)]);
    return mapCompany(rows[0], members.length, linkedOpportunities.length);
  }

  async resolve(idOrName: string): Promise<Company | null> {
    const byId = await this.get(idOrName);
    if (byId) return byId;
    const rows = await db.select().from(companies).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), companyScope, ilike(companies.name, idOrName))).limit(1);
    return rows[0] ? mapCompany(rows[0]) : null;
  }

  async create(input: Pick<Company, "name"> & Partial<Omit<Company, "id" | "name" | "createdAt" | "updatedAt">>): Promise<Company> {
    const name = input.name.trim();
    if (!name) throw new Error("Company name is required");
    const existing = await this.resolve(name);
    if (existing && existing.name.toLowerCase() === name.toLowerCase()) throw new Error(`Company already exists: ${existing.name}`);
    const now = new Date();
    const row = {
      id: companyId(),
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), companyScope),
      name,
      description: input.description?.trim() || null,
      website: input.website?.trim() || null,
      industry: input.industry?.trim() || null,
      location: input.location?.trim() || null,
      notes: input.notes?.trim() || null,
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(companies).values(row);
    return mapCompany(row);
  }

  async update(id: string, updates: Partial<Pick<Company, "name" | "description" | "website" | "industry" | "location" | "notes" | "tags">>): Promise<Company> {
    const current = await this.get(id);
    if (!current) throw new Error("Company not found");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const field of ["name", "description", "website", "industry", "location", "notes"] as const) {
      if (updates[field] !== undefined) patch[field] = updates[field]?.trim() || null;
    }
    if (updates.tags !== undefined) patch.tags = updates.tags;
    if (patch.name === null) throw new Error("Company name is required");
    const rows = await db.update(companies).set(patch).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), companyScope, eq(companies.id, id))).returning();
    if (!rows[0]) throw new Error("Company not writable");
    if (updates.name && updates.name !== current.name) {
      await db.update(persons).set({ company: updates.name, updatedAt: new Date() }).where(combineWithWritableScope(getCurrentPrincipalOrSystem(), personScope, eq(persons.companyId, id)));
    }
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    const principal = getCurrentPrincipalOrSystem();
    await db.transaction(async tx => {
      await tx.update(persons).set({ companyId: null, company: null, updatedAt: new Date() }).where(combineWithWritableScope(principal, personScope, eq(persons.companyId, id)));
      await tx.update(opportunities).set({ companyId: null, company: null, updatedAt: new Date() }).where(combineWithWritableScope(principal, opportunityScope, eq(opportunities.companyId, id)));
      await tx.delete(companies).where(combineWithWritableScope(principal, companyScope, eq(companies.id, id)));
    });
  }

  async listPeople(id: string) {
    return db.select({ id: persons.id, name: persons.name, role: persons.role, company: persons.company })
      .from(persons)
      .where(visiblePersonPredicate(getCurrentPrincipalOrSystem(), eq(persons.companyId, id)));
  }

  async listOpportunities(id: string) {
    const { opportunityStorage } = await import("./opportunity-storage");
    return opportunityStorage.listForCompany(id, getCurrentPrincipalOrSystem());
  }

  async addOpportunity(companyIdValue: string, opportunityId: number): Promise<void> {
    const company = await this.get(companyIdValue);
    if (!company) throw new Error("Company not found");
    const { opportunityStorage } = await import("./opportunity-storage");
    const row = await opportunityStorage.setCompany(opportunityId, company.id, getCurrentPrincipalOrSystem());
    if (!row) throw new Error("Opportunity not found or not writable");
  }

  async removeOpportunity(companyIdValue: string, opportunityId: number): Promise<void> {
    const { opportunityStorage } = await import("./opportunity-storage");
    const current = await opportunityStorage.get(opportunityId, getCurrentPrincipalOrSystem());
    if (!current || current.companyId !== companyIdValue) throw new Error("Opportunity is not linked to this company");
    await opportunityStorage.setCompany(opportunityId, null, getCurrentPrincipalOrSystem());
  }

  async addPerson(companyIdValue: string, personId: string): Promise<void> {
    const company = await this.get(companyIdValue);
    if (!company) throw new Error("Company not found");
    const rows = await db.update(persons).set({ companyId: company.id, company: company.name, updatedAt: new Date() })
      .where(writablePersonPredicate(getCurrentPrincipalOrSystem(), eq(persons.id, personId))).returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person not found or not writable");
  }

  async removePerson(companyIdValue: string, personId: string): Promise<void> {
    const rows = await db.update(persons).set({ companyId: null, company: null, updatedAt: new Date() })
      .where(writablePersonPredicate(getCurrentPrincipalOrSystem(), and(eq(persons.id, personId), eq(persons.companyId, companyIdValue)))).returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person is not linked to this company");
  }
}

export const companyStorage = new CompanyStorage();
