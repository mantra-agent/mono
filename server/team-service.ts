import { and, eq, inArray, sql } from "drizzle-orm";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, type DrizzleTx } from "./db";
import { memberships, privilegedAccessAudit, teams, teamMembers, users, type TeamRow } from "@shared/schema";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";

const log = createLogger("TeamService");

export interface TeamMemberView {
  userId: string;
  role: "admin" | "member";
  label: string;
  email: string | null;
}

export interface TeamView extends TeamRow {
  memberCount: number;
}

async function writeTeamAudit(
  tx: DrizzleTx,
  principal: ReturnType<typeof requireCurrentUserPrincipal>,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(privilegedAccessAudit).values({
    actorType: principal.actorType,
    actorUserId: principal.userId,
    actorAccountId: principal.accountId,
    impersonatedUserId: null,
    impersonatedAccountId: null,
    action,
    reason: null,
    scopes: principal.scopes,
    metadata,
  });
}

/**
 * Teams are grant-addressable groups scoped to an account. Every read and mutation is bounded to the
 * current user's account, so teams never leak across accounts. A team is only ever an object_grant
 * subject — creating or editing a team grants no object access on its own.
 */
export class TeamService {
  /** All teams in the caller's account, with live member counts. */
  async list(): Promise<TeamView[]> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db
      .select({
        id: teams.id,
        accountId: teams.accountId,
        name: teams.name,
        createdByUserId: teams.createdByUserId,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        // Qualify outer teams.id — bare ${teams.id} emits "id", which binds to team_members.id (serial)
        // inside the subquery and fails with integer = text.
        memberCount: sql<number>`(SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = "teams"."id")`,
      })
      .from(teams)
      .where(eq(teams.accountId, principal.accountId))
      .orderBy(teams.name);
    return rows;
  }

  /** Fetch one team the caller's account owns, or throw 404. */
  private async requireOwnedTeam(teamId: string): Promise<TeamRow> {
    const principal = requireCurrentUserPrincipal();
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.accountId, principal.accountId)))
      .limit(1);
    if (!team) throw Object.assign(new Error("Team not found"), { status: 404 });
    return team;
  }

  async create(name: string): Promise<TeamRow> {
    const principal = requireCurrentUserPrincipal();
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("Team name is required"), { status: 400 });
    try {
      const team = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(teams)
          .values({ accountId: principal.accountId, name: trimmed, createdByUserId: principal.userId })
          .returning();
        // Creator joins as an admin member so the team is immediately manageable and grant-useful.
        await tx
          .insert(teamMembers)
          .values({ teamId: created.id, userId: principal.userId, role: "admin", addedByUserId: principal.userId })
          .onConflictDoNothing();
        await writeTeamAudit(tx, principal, "team.created", { teamId: created.id });
        return created;
      });
      log.info("team created", { teamId: team.id, accountId: principal.accountId });
      return team;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw Object.assign(new Error("A team with that name already exists"), { status: 409 });
      }
      throw err;
    }
  }

  async rename(teamId: string, name: string): Promise<TeamRow> {
    const principal = requireCurrentUserPrincipal();
    await this.requireOwnedTeam(teamId);
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("Team name is required"), { status: 400 });
    const team = await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `team:${teamId}`);
      const [updated] = await tx
        .update(teams)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(and(eq(teams.id, teamId), eq(teams.accountId, principal.accountId)))
        .returning();
      if (!updated) throw Object.assign(new Error("Team not found"), { status: 404 });
      await writeTeamAudit(tx, principal, "team.renamed", { teamId });
      return updated;
    });
    return team;
  }

  async remove(teamId: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    await this.requireOwnedTeam(teamId);
    await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `team:${teamId}`);
      // team_members cascades on delete; live object_grants targeting this team stop resolving because
      // membership expansion returns no rows. Grants are ledger rows and are left as historical record.
      const removed = await tx.delete(teams).where(and(eq(teams.id, teamId), eq(teams.accountId, principal.accountId))).returning({ id: teams.id });
      if (removed.length === 0) throw Object.assign(new Error("Team not found"), { status: 404 });
      await writeTeamAudit(tx, principal, "team.removed", { teamId });
    });
    log.info("team removed", { teamId });
  }

  async members(teamId: string): Promise<TeamMemberView[]> {
    await this.requireOwnedTeam(teamId);
    const rows = await db
      .select({
        userId: teamMembers.userId,
        role: teamMembers.role,
        email: users.email,
        name: users.name,
      })
      .from(teamMembers)
      .leftJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId));
    return rows.map((r) => ({
      userId: r.userId,
      role: r.role as "admin" | "member",
      label: r.name ?? r.email ?? r.userId,
      email: r.email ?? null,
    }));
  }

  /** Add a member by user id or email. Only users who already exist can be added (teams are internal). */
  async addMember(teamId: string, opts: { userId?: string; email?: string; role?: "admin" | "member" }): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    await this.requireOwnedTeam(teamId);
    let userId = opts.userId?.trim() || "";
    if (!userId && opts.email) {
      const normalized = opts.email.trim().toLowerCase();
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.accountId, principal.accountId)))
        .where(eq(sql`LOWER(${users.email})`, normalized))
        .limit(1);
      if (!u) throw Object.assign(new Error("No user in this account with that email"), { status: 404 });
      userId = u.id;
    }
    if (!userId) throw Object.assign(new Error("A userId or email is required"), { status: 400 });
    const [accountMember] = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.accountId, principal.accountId), eq(memberships.userId, userId)))
      .limit(1);
    if (!accountMember) throw Object.assign(new Error("User is not a member of this account"), { status: 404 });

    const role = opts.role ?? "member";
    await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `team:${teamId}`);
      const [current] = await tx
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .innerJoin(teams, and(eq(teams.id, teamMembers.teamId), eq(teams.accountId, principal.accountId)))
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
        .limit(1);
      if (current?.role === role) return;
      if (current) {
        await tx
          .update(teamMembers)
          .set({ role, addedByUserId: principal.userId })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      } else {
        await tx
          .insert(teamMembers)
          .values({ teamId, userId, role, addedByUserId: principal.userId });
      }
      await writeTeamAudit(tx, principal, current ? "team.member_role_updated" : "team.member_added", { teamId, userId, role });
    });
    log.info("team member set", { teamId, userId, role });
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    await this.requireOwnedTeam(teamId);
    const normalizedUserId = userId.trim();
    await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `team:${teamId}`);
      const removed = await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, normalizedUserId)))
        .returning({ id: teamMembers.id });
      if (removed.length === 0) return;
      await writeTeamAudit(tx, principal, "team.member_removed", { teamId, userId: normalizedUserId });
    });
    log.info("team member removed", { teamId, userId: normalizedUserId });
  }

  /** Resolve display labels for a set of team ids in the caller's account (for grant projection). */
  async labelsFor(teamIds: string[]): Promise<Map<string, string>> {
    const principal = requireCurrentUserPrincipal();
    if (teamIds.length === 0) return new Map();
    const rows = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(inArray(teams.id, teamIds), eq(teams.accountId, principal.accountId)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}

export const teamService = new TeamService();
