import type { Express } from "express";
import { requireAuth } from "./auth";
import { createLogger } from "./log";
import { goalsService } from "./goals-service";
import { peopleStorage } from "./people-storage";
import { fileTaskStorage } from "./file-storage/tasks";
import { fileProjectStorage } from "./file-storage/projects";
import { db } from "./db";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope } from "./scoped-storage";
import { libraryPages } from "@shared/models/info";
import { wellnessActivities } from "@shared/models/health";
import { emailMessages } from "@shared/schema";
import { decisionsStorage } from "./decisions-storage";
import { and, desc, eq, or } from "drizzle-orm";
import { getEvent, listAllEvents } from "./google-calendar";
import { chatFileStorage } from "./chat-file-storage";

const log = createLogger("ReferenceRoutes");

/**
 * Batch-resolve reference labels by type:id.
 * GET /api/references/resolve?refs=goal:abc,task:42,person:xyz
 * Returns: { "goal:abc": "Plan Week", "task:42": "Deploy page" }
 */
export function registerReferenceRoutes(app: Express) {
  app.get("/api/references/resolve", requireAuth, async (req, res) => {
    const principal = getCurrentPrincipalOrSystem();
    const emailScope = { ownerUserId: emailMessages.ownerUserId, accountId: emailMessages.principalAccountId };
    const refsParam = req.query.refs as string | undefined;
    if (!refsParam) return res.json({});

    const refs = refsParam
      .split(",")
      .map((r) => {
        const colonIdx = r.indexOf(":");
        if (colonIdx <= 0) return null;
        return { type: r.slice(0, colonIdx), id: r.slice(colonIdx + 1) };
      })
      .filter(Boolean) as { type: string; id: string }[];

    if (refs.length === 0) return res.json({});
    if (refs.length > 50) return res.status(400).json({ error: "Too many refs (max 50)" });

    const results: Record<string, string> = {};

    await Promise.all(
      refs.map(async ({ type, id }) => {
        const key = `${type}:${id}`;
        try {
          switch (type) {
            case "goal": {
              const goal = await goalsService.get(id);
              if (goal) results[key] = goal.shortName;
              break;
            }
            case "task": {
              const numId = Number(id);
              if (!Number.isNaN(numId)) {
                const task = await fileTaskStorage.getTask(numId);
                if (task) results[key] = task.title;
              }
              break;
            }

            case "meeting": {
              const parts = id.split("~").map(decodeURIComponent);
              if (parts.length === 3) {
                const [accountId, calendarId, eventId] = parts;
                const event = await getEvent(accountId, calendarId, eventId);
                if (event) results[key] = event.summary || "Calendar event";
              } else {
                const { events } = await listAllEvents({
                  timeMin: new Date(Date.now() - 7 * 86400000).toISOString(),
                  timeMax: new Date(Date.now() + 370 * 86400000).toISOString(),
                  maxResults: 250,
                });
                const event = events.find(e => e.id === id);
                if (event) results[key] = event.summary || "Calendar event";
              }
              break;
            }
            case "project": {
              const numId = Number(id);
              if (!Number.isNaN(numId)) {
                const project = await fileProjectStorage.getProject(numId);
                if (project) results[key] = project.title;
              }
              break;
            }
            case "session": {
              const session = await chatFileStorage.getSession(id);
              if (session) results[key] = session.title || "Untitled session";
              break;
            }
            case "person": {
              const person = await peopleStorage.getPerson(id);
              if (person) results[key] = person.name;
              break;
            }
            case "page": {
              const pageScope = { ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, scope: libraryPages.scope };
              const matchers = [eq(libraryPages.slug, id), eq(libraryPages.id, id)];
              // Heal legacy refs authored with a memory entry ID instead of a page slug/id.
              const numId = Number(id);
              if (Number.isInteger(numId)) matchers.push(eq(libraryPages.memoryEntryId, numId));
              const rows = await db
                .select({ title: libraryPages.title })
                .from(libraryPages)
                .where(combineWithVisibleScope(principal, pageScope, or(...matchers)))
                .limit(1);
              if (rows[0]?.title) results[key] = rows[0].title;
              break;
            }
            case "wellness_activity":
            case "health_activity": {
              const numId = Number(id);
              if (!Number.isNaN(numId)) {
                const activityScope = { ownerUserId: wellnessActivities.ownerUserId, accountId: wellnessActivities.principalAccountId };
                const rows = await db
                  .select({ name: wellnessActivities.name })
                  .from(wellnessActivities)
                  .where(combineWithVisibleScope(principal, activityScope, eq(wellnessActivities.id, numId)))
                  .limit(1);
                if (rows[0]) results[key] = rows[0].name;
              }
              break;
            }
            case "decision": {
              const decision = await decisionsStorage.getDecision(id);
              if (decision) results[key] = decision.title;
              break;
            }
            case "milestone": {
              const numId = Number(id);
              if (!Number.isNaN(numId)) {
                const projects = await fileProjectStorage.getProjects();
                for (const project of projects) {
                  const milestone = project.milestones?.find((m) => m.id === numId);
                  if (milestone) {
                    results[key] = milestone.name;
                    break;
                  }
                }
              }
              break;
            }
            case "email_thread": {
              const colonIdx = id.indexOf(":");
              if (colonIdx > 0) {
                const accountId = id.slice(0, colonIdx);
                const providerThreadId = id.slice(colonIdx + 1);
                const rows = await db
                  .select({ subject: emailMessages.subject, fromAddress: emailMessages.fromAddress })
                  .from(emailMessages)
                  .where(combineWithVisibleScope(principal, emailScope, and(eq(emailMessages.accountId, accountId), eq(emailMessages.providerThreadId, providerThreadId))))
                  .orderBy(desc(emailMessages.date))
                  .limit(1);
                if (rows[0]) results[key] = rows[0].subject || rows[0].fromAddress || "Email thread";
              }
              break;
            }
            case "email_message": {
              const numId = Number(id);
              if (!Number.isNaN(numId)) {
                const rows = await db
                  .select({ subject: emailMessages.subject, fromAddress: emailMessages.fromAddress })
                  .from(emailMessages)
                  .where(combineWithVisibleScope(principal, emailScope, eq(emailMessages.id, numId)))
                  .limit(1);
                if (rows[0]) results[key] = rows[0].subject || rows[0].fromAddress || "Email message";
              }
              break;
            }
          }
        } catch (err) {
          log.warn(`resolve failed for ${key}: ${err}`);
        }
      }),
    );

    res.json(results);
  });
}
