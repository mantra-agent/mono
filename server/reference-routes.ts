import type { Express } from "express";
import { requireAuth } from "./auth";
import { createLogger } from "./log";
import { goalsService } from "./goals-service";
import { peopleStorage } from "./people-storage";
import { fileTaskStorage } from "./file-storage/tasks";
import { fileProjectStorage } from "./file-storage/projects";
import { db } from "./db";
import { libraryPages } from "@shared/models/info";
import { eq, or } from "drizzle-orm";
import { getEvent, listAllEvents } from "./google-calendar";

const log = createLogger("ReferenceRoutes");

/**
 * Batch-resolve reference labels by type:id.
 * GET /api/references/resolve?refs=goal:abc,task:42,person:xyz
 * Returns: { "goal:abc": "Plan Week", "task:42": "Deploy page" }
 */
export function registerReferenceRoutes(app: Express) {
  app.get("/api/references/resolve", requireAuth, async (req, res) => {
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
            case "person": {
              const person = await peopleStorage.getPerson(id);
              if (person) results[key] = person.name;
              break;
            }
            case "page": {
              const rows = await db
                .select({ title: libraryPages.title })
                .from(libraryPages)
                .where(or(eq(libraryPages.slug, id), eq(libraryPages.id, id)))
                .limit(1);
              if (rows[0]) results[key] = rows[0].title;
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
