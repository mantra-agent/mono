import { randomBytes } from "crypto";
import { and, eq, ilike } from "drizzle-orm";
import { companies, persons } from "@shared/schema";
import { db } from "./db";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const companyScope = { scope: companies.scope, ownerUserId: companies.ownerUserId, accountId: companies.accountId };
const personScope = { scope: persons.scope, ownerUserId: persons.ownerUserId, accountId: persons.accountId, vaultId: persons.vaultId };

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
  createdAt: string;
  updatedAt: string;
}

function companyId(): string {
  return randomBytes(4).toString("hex");
}

function mapCompany(row: typeof companies.$inferSelect, peopleCount?: number): Company {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class CompanyStorage {
  async list(query?: string): Promise<Company[]> {
    const principal = getCurrentPrincipalOrSystem();
    const predicate = query?.trim() ? ilike(companies.name, `%${query.trim()}%`) : undefined;
    const rows = await db.select().from(companies).where(combineWithVisibleScope(principal, companyScope, predicate));
    const visiblePeople = await db.select({ companyId: persons.companyId }).from(persons).where(combineWithVisibleScope(principal, personScope));
    const counts = new Map<string, number>();
    for (const person of visiblePeople) {
      if (person.companyId) counts.set(person.companyId, (counts.get(person.companyId) || 0) + 1);
    }
    return rows.map(row => mapCompany(row, counts.get(row.id) || 0)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Company | null> {
    const rows = await db.select().from(companies).where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), companyScope, eq(companies.id, id))).limit(1);
    if (!rows[0]) return null;
    const members = await this.listPeople(id);
    return mapCompany(rows[0], members.length);
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
      await tx.delete(companies).where(combineWithWritableScope(principal, companyScope, eq(companies.id, id)));
    });
  }

  async listPeople(id: string) {
    return db.select({ id: persons.id, name: persons.name, role: persons.role, company: persons.company })
      .from(persons)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), personScope, eq(persons.companyId, id)));
  }

  async addPerson(companyIdValue: string, personId: string): Promise<void> {
    const company = await this.get(companyIdValue);
    if (!company) throw new Error("Company not found");
    const rows = await db.update(persons).set({ companyId: company.id, company: company.name, updatedAt: new Date() })
      .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), personScope, eq(persons.id, personId))).returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person not found or not writable");
  }

  async removePerson(companyIdValue: string, personId: string): Promise<void> {
    const rows = await db.update(persons).set({ companyId: null, company: null, updatedAt: new Date() })
      .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), personScope, and(eq(persons.id, personId), eq(persons.companyId, companyIdValue)))).returning({ id: persons.id });
    if (!rows[0]) throw new Error("Person is not linked to this company");
  }
}

export const companyStorage = new CompanyStorage();
