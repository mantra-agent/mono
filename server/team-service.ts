import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { teams, teamMembers, users, type TeamRow } from "@shared/schema";
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
        memberCount: sql<number>`(SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = ${teams.id})`,
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
      const [team] = await db
        .insert(teams)
        .values({ accountId: principal.accountId, name: trimmed, createdByUserId: principal.userId })
        .returning();
      // Creator joins as an admin member so the team is immediately manageable and grant-useful.
      await db
        .insert(teamMembers)
        .values({ teamId: team.id, userId: principal.userId, role: "admin", addedByUserId: principal.userId })
        .onConflictDoNothing();
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
    await this.requireOwnedTeam(teamId);
    const trimmed = name.trim();
    if (!trimmed) throw Object.assign(new Error("Team name is required"), { status: 400 });
    const [team] = await db
      .update(teams)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(teams.id, teamId))
      .returning();
    return team;
  }

  async remove(teamId: string): Promise<void> {
    await this.requireOwnedTeam(teamId);
    // team_members cascades on delete; live object_grants targeting this team stop resolving because
    // membership expansion returns no rows. Grants are ledger rows and are left as historical record.
    await db.delete(teams).where(eq(teams.id, teamId));
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
      const [u] = await db.select({ id: users.id }).from(users).where(eq(sql`LOWER(${users.email})`, normalized)).limit(1);
      if (!u) throw Object.assign(new Error("No user with that email"), { status: 404 });
      userId = u.id;
    }
    if (!userId) throw Object.assign(new Error("A userId or email is required"), { status: 400 });
    await db
      .insert(teamMembers)
      .values({ teamId, userId, role: opts.role ?? "member", addedByUserId: principal.userId })
      .onConflictDoNothing();
    log.info("team member added", { teamId, userId });
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.requireOwnedTeam(teamId);
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId.trim())));
    log.info("team member removed", { teamId, userId });
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
