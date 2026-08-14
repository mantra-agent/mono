import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "./db";
import { organizations, organizationMembers, users, type OrganizationRow } from "@shared/schema";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";

const log = createLogger("OrganizationService");

export interface OrganizationMemberView {
  userId: string;
  role: "admin" | "member";
  label: string;
  email: string | null;
}

export interface OrganizationView extends OrganizationRow {
  memberCount: number;
}

/**
 * Organizations are cross-account billing collections and grant-addressable subjects. Unlike teams
 * (account-scoped, many-to-many), an org sits above accounts and a user belongs to at most one org.
 * Management is rooted in *ownership* (ownerUserId = billing authority), not account membership, so
 * the caller can only mutate orgs they own. An org is only ever an object_grant subject — creating
 * or editing one grants no object access on its own.
 */
export class OrganizationService {
  /** Orgs the caller owns or belongs to, with live member counts. */
  async list(): Promise<OrganizationView[]> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        ownerUserId: organizations.ownerUserId,
        billingEmail: organizations.billingEmail,
        createdByUserId: organizations.createdByUserId,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        // Qualify outer organizations.id — bare ${organizations.id} emits "id", which binds to
        // organization_members.id (serial) inside the subquery and fails with integer = text.
        memberCount: sql<number>`(SELECT COUNT(*)::int FROM organization_members om WHERE om.organization_id = "organizations"."id")`,
      })
      .from(organizations)
      .where(
        or(
          eq(organizations.ownerUserId, principal.userId),
          sql`EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = "organizations"."id" AND om.user_id = ${principal.userId})`,
        ),
      )
      .orderBy(organizations.name);
    return rows;
  }

  /** Fetch one org the caller owns, or throw 404. Ownership (billing authority) roots management. */
  private async requireOwnedOrg(organizationId: string): Promise<OrganizationRow> {
    const principal = requireCurrentUserPrincipal();
    const [org] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), eq(organizations.ownerUserId, principal.userId)))
      .limit(1);
    if (!org) throw Object.assign(new Error("Organization not found"), { status: 404 });
    return org;
  }

  async create(name: string, billingEmail?: string): Promise<OrganizationRow> {
    const principal = requireCurrentUserPrincipal();
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("Organization name is required"), { status: 400 });
    const [org] = await db
      .insert(organizations)
      .values({
        name: trimmed,
        ownerUserId: principal.userId,
        billingEmail: billingEmail?.trim() || null,
        createdByUserId: principal.userId,
      })
      .returning();
    // Creator joins as an admin member so the org is immediately manageable and grant-useful.
    // Tolerates the 0..1 constraint: if the creator already belongs to an org, they still own this
    // one (ownership roots management) but are not double-added as a member.
    try {
      await db
        .insert(organizationMembers)
        .values({ organizationId: org.id, userId: principal.userId, role: "admin", addedByUserId: principal.userId })
        .onConflictDoNothing();
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
    log.info("organization created", { organizationId: org.id, ownerUserId: principal.userId });
    return org;
  }

  async update(organizationId: string, patch: { name?: string; billingEmail?: string | null }): Promise<OrganizationRow> {
    await this.requireOwnedOrg(organizationId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw Object.assign(new Error("Organization name is required"), { status: 400 });
      set.name = trimmed;
    }
    if (patch.billingEmail !== undefined) {
      set.billingEmail = patch.billingEmail?.trim() || null;
    }
    const [org] = await db.update(organizations).set(set).where(eq(organizations.id, organizationId)).returning();
    return org;
  }

  async remove(organizationId: string): Promise<void> {
    await this.requireOwnedOrg(organizationId);
    // organization_members cascades on delete; live object_grants targeting this org stop resolving
    // because membership expansion returns no rows. Grants are ledger rows, left as historical record.
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    log.info("organization removed", { organizationId });
  }

  async members(organizationId: string): Promise<OrganizationMemberView[]> {
    await this.requireOwnedOrg(organizationId);
    const rows = await db
      .select({
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        email: users.email,
        name: users.name,
      })
      .from(organizationMembers)
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId));
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role as "admin" | "member",
      label: r.name ?? r.email ?? r.userId,
      email: r.email ?? null,
    }));
  }

  /** Add a member by user id or email. The 0..1 org constraint surfaces as a 409 conflict. */
  async addMember(organizationId: string, opts: { userId?: string; email?: string; role?: "admin" | "member" }): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    await this.requireOwnedOrg(organizationId);
    let userId = opts.userId?.trim() || "";
    if (!userId && opts.email) {
      const normalized = opts.email.trim().toLowerCase();
      const [u] = await db.select({ id: users.id }).from(users).where(eq(sql`LOWER(${users.email})`, normalized)).limit(1);
      if (!u) throw Object.assign(new Error("No user with that email"), { status: 404 });
      userId = u.id;
    }
    if (!userId) throw Object.assign(new Error("A userId or email is required"), { status: 400 });
    try {
      const inserted = await db
        .insert(organizationMembers)
        .values({ organizationId, userId, role: opts.role ?? "member", addedByUserId: principal.userId })
        .onConflictDoNothing()
        .returning();
      // onConflictDoNothing on the (organization_id, user_id) pair is a no-op re-add; the unique
      // index on user_id ALONE raises 23505 when the user is already in a *different* org.
      if (inserted.length === 0) {
        const [existing] = await db
          .select({ organizationId: organizationMembers.organizationId })
          .from(organizationMembers)
          .where(eq(organizationMembers.userId, userId))
          .limit(1);
        if (existing && existing.organizationId !== organizationId) {
          throw Object.assign(new Error("User already belongs to an organization"), { status: 409 });
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw Object.assign(new Error("User already belongs to an organization"), { status: 409 });
      }
      throw err;
    }
    log.info("organization member added", { organizationId, userId });
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    await this.requireOwnedOrg(organizationId);
    await db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId.trim())));
    log.info("organization member removed", { organizationId, userId });
  }

  /** Resolve display labels for a set of org ids the caller owns or belongs to (for grant projection). */
  async labelsFor(organizationIds: string[]): Promise<Map<string, string>> {
    const principal = requireCurrentUserPrincipal();
    if (organizationIds.length === 0) return new Map();
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(
          inArray(organizations.id, organizationIds),
          or(
            eq(organizations.ownerUserId, principal.userId),
            sql`EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = ${organizations.id} AND om.user_id = ${principal.userId})`,
          ),
        ),
      );
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

export const organizationService = new OrganizationService();
