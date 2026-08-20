import type { Express, Request, Response } from "express";
import { inArray } from "drizzle-orm";
import { db } from "./db";
import { users, invitedSubjects } from "@shared/schema";
import { createLogger } from "./log";
import {
  objectGrantService,
  type GrantableObjectType,
  type ObjectGrantSubjectType,
  type ObjectGrantTarget,
} from "./object-grant-service";
import type { ObjectGrantCapability } from "./object-grant-access";
import { teamService } from "./team-service";
import { organizationService } from "./organization-service";

const log = createLogger("ObjectGrantRoutes");

const GRANTABLE_OBJECT_TYPES: GrantableObjectType[] = ["project", "milestone", "task", "library_page", "vault", "drive_resource"];
const CAPABILITIES: ObjectGrantCapability[] = ["read", "write", "admin"];
const SUBJECT_TYPES: ObjectGrantSubjectType[] = ["user", "invited_subject", "team", "organization"];

/** Library pages key on a text uuid; work objects key on an integer id. */
function normalizeObjectId(objectType: GrantableObjectType, raw: string): number | string {
  if (objectType === "library_page" || objectType === "vault" || objectType === "drive_resource") return raw;
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("Invalid object id"), { status: 400 });
  return id;
}

function parseTarget(req: Request): ObjectGrantTarget {
  const objectType = req.params.objectType as GrantableObjectType;
  if (!GRANTABLE_OBJECT_TYPES.includes(objectType)) {
    throw Object.assign(new Error(`Unsupported object type: ${objectType}`), { status: 400 });
  }
  const objectId = normalizeObjectId(objectType, req.params.objectId);
  const projectId = req.body?.projectId ?? (req.query.projectId ? Number(req.query.projectId) : undefined);
  return { objectType, objectId, projectId: projectId != null ? Number(projectId) : undefined };
}

/** Resolve display labels for grant subjects without leaking non-owned identities. */
async function projectSubjects(
  grants: Array<{ subjectType: string; subjectId: string; capability: string; createdAt: Date }>,
) {
  const userIds = grants.filter(g => g.subjectType === "user").map(g => g.subjectId);
  const invitedIds = grants.filter(g => g.subjectType === "invited_subject").map(g => g.subjectId);
  const teamIds = grants.filter(g => g.subjectType === "team").map(g => g.subjectId);
  const orgIds = grants.filter(g => g.subjectType === "organization").map(g => g.subjectId);
  const userRows = userIds.length
    ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds))
    : [];
  const invitedRows = invitedIds.length
    ? await db
        .select({ id: invitedSubjects.id, label: invitedSubjects.displayLabel, email: invitedSubjects.normalizedEmail })
        .from(invitedSubjects)
        .where(inArray(invitedSubjects.id, invitedIds))
    : [];
  const userMap = new Map(userRows.map(r => [r.id, r]));
  const invitedMap = new Map(invitedRows.map(r => [r.id, r]));
  const teamMap = teamIds.length ? await teamService.labelsFor(teamIds) : new Map<string, string>();
  const orgMap = orgIds.length ? await organizationService.labelsFor(orgIds) : new Map<string, string>();
  return grants.map(g => {
    if (g.subjectType === "user") {
      const u = userMap.get(g.subjectId);
      return { ...g, label: u?.email ?? g.subjectId, email: u?.email ?? null };
    }
    if (g.subjectType === "team") {
      return { ...g, label: teamMap.get(g.subjectId) ?? "Team", email: null };
    }
    if (g.subjectType === "organization") {
      return { ...g, label: orgMap.get(g.subjectId) ?? "Organization", email: null };
    }
    const s = invitedMap.get(g.subjectId);
    return { ...g, label: s?.label ?? s?.email ?? g.subjectId, email: s?.email ?? null };
  });
}

function handleError(res: Response, error: unknown, fallback: string) {
  const status = (error as { status?: number })?.status ?? 500;
  const message = error instanceof Error ? error.message : fallback;
  if (status >= 500) log.error(fallback, { error: message });
  res.status(status).json({ error: message });
}

export function registerObjectGrantRoutes(app: Express) {
  // Recent person subjects this caller has granted (Share sheet recents). Caller-scoped only.
  app.get("/api/objects/grants/recent-people", async (_req, res) => {
    try {
      const people = await objectGrantService.listRecentPeople();
      res.json({ people });
    } catch (error: unknown) {
      handleError(res, error, "Failed to list recent share people");
    }
  });

  // Who has access — admin-gated list of live grants with display labels.
  app.get("/api/objects/:objectType/:objectId/grants", async (req, res) => {
    try {
      const grants = await objectGrantService.list(parseTarget(req));
      res.json({ grants: await projectSubjects(grants) });
    } catch (error: unknown) {
      handleError(res, error, "Failed to list object grants");
    }
  });

  // Grant access. Accepts an explicit subject or a raw email (shared as an invited subject).
  app.post("/api/objects/:objectType/:objectId/grants", async (req, res) => {
    try {
      const target = parseTarget(req);
      const capability = req.body?.capability as ObjectGrantCapability;
      if (!CAPABILITIES.includes(capability)) {
        throw Object.assign(new Error("capability must be read, write, or admin"), { status: 400 });
      }
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      const explicitSubjectType = req.body?.subjectType as ObjectGrantSubjectType | undefined;
      const subjectType = explicitSubjectType ?? (email ? "invited_subject" : undefined);
      // Team/organization subjects carry an explicit id in subjectId; only user/invited use email.
      const subjectId = subjectType === "team" || subjectType === "organization"
        ? (typeof req.body?.subjectId === "string" ? req.body.subjectId.trim() : "")
        : email || (typeof req.body?.subjectId === "string" ? req.body.subjectId.trim() : "");
      if (!subjectType || !SUBJECT_TYPES.includes(subjectType) || !subjectId) {
        throw Object.assign(new Error("A subjectId or email and subjectType are required"), { status: 400 });
      }
      // Fail closed on cross-account team ids: only teams the caller's account owns may be granted.
      if (subjectType === "team" && !(await teamService.labelsFor([subjectId])).has(subjectId)) {
        throw Object.assign(new Error("Team not found"), { status: 404 });
      }
      // Fail closed on org ids: only orgs the caller owns or belongs to may be granted.
      if (subjectType === "organization" && !(await organizationService.labelsFor([subjectId])).has(subjectId)) {
        throw Object.assign(new Error("Organization not found"), { status: 404 });
      }
      const grant = await objectGrantService.grant({
        ...target,
        subjectType,
        subjectId,
        capability,
        originType: "manual",
      });
      res.status(201).json({ grant });
    } catch (error: unknown) {
      handleError(res, error, "Failed to grant object access");
    }
  });

  // Revoke access.
  app.delete("/api/objects/:objectType/:objectId/grants", async (req, res) => {
    try {
      const target = parseTarget(req);
      const subjectType = req.body?.subjectType as ObjectGrantSubjectType;
      const subjectId = typeof req.body?.subjectId === "string" ? req.body.subjectId.trim() : "";
      if (!SUBJECT_TYPES.includes(subjectType) || !subjectId) {
        throw Object.assign(new Error("subjectType and subjectId are required"), { status: 400 });
      }
      const revoked = await objectGrantService.revoke({ ...target, subjectType, subjectId });
      res.json({ revoked });
    } catch (error: unknown) {
      handleError(res, error, "Failed to revoke object access");
    }
  });
}
