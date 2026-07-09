// Use createLogger for logging ONLY
import type { Express } from "express";
import { requireAuth } from "./auth";
import { PeopleStorage } from "./people-storage";
import { tagRegistry } from "./file-storage";
import { chatCompletion } from "./model-client";
import { getPromptModulePrompt } from "./prompt-modules";
import { contextBuilder } from "./context-builder";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { createLogger } from "./log";
import { unifiedMemorySearch } from "./memory/unified-search";

const log = createLogger("PeopleRoutes");

export function registerPeopleRoutes(app: Express, peopleStorage: PeopleStorage): void {
  app.use("/api/people", requireAuth);
  app.use("/api/trust-config", requireAuth);

  app.post("/api/people/rebuild-index", async (_req, res) => {
    log.log(`POST /api/people/rebuild-index`);
    try {
      await peopleStorage.rebuildIndex();
      const people = await peopleStorage.listPeople();
      res.json({ rebuilt: true, count: people.length });
    } catch (error: any) {
      log.error(`POST /api/people/rebuild-index error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/cabinet-config", async (_req, res) => {
    log.debug(`GET /api/people/cabinet-config`);
    try {
      const config = await peopleStorage.getCabinetConfig();
      res.json(config);
    } catch (error: any) {
      log.error(`GET /api/people/cabinet-config error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/people/cabinet-config", async (req, res) => {
    log.log(`PUT /api/people/cabinet-config`);
    try {
      const { levels } = req.body;
      if (!levels || !Array.isArray(levels)) {
        return res.status(400).json({ error: "levels array is required" });
      }
      await peopleStorage.saveCabinetConfig({ levels });
      res.json({ levels });
    } catch (error: any) {
      log.error(`PUT /api/people/cabinet-config error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/companies", async (_req, res) => {
    log.debug(`GET /api/people/companies`);
    try {
      const people = await peopleStorage.listPeople();
      const allPeople = await peopleStorage.getPeopleByIds(people.map(p => p.id));
      const companies = [...new Set(
        allPeople.filter(p => p.company).map(p => p.company!)
      )].sort();
      res.json({ companies });
    } catch (error: any) {
      log.error(`GET /api/people/companies error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/search", async (req, res) => {
    log.debug(`GET /api/people/search q=${req.query.q}`);
    try {
      const q = (req.query.q as string) || "";
      if (!q) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }
      const people = await peopleStorage.searchPeople(q);
      res.json({ people });
    } catch (error: any) {
      log.error(`GET /api/people/search error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/time-budgets", async (_req, res) => {
    log.debug(`GET /api/people/time-budgets`);
    try {
      const budgets = await peopleStorage.getTimeBudgets();
      res.json(budgets);
    } catch (error: any) {
      log.error(`GET /api/people/time-budgets error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/people/time-budgets", async (req, res) => {
    log.log(`PUT /api/people/time-budgets`);
    try {
      const { weeklyGoals } = req.body;
      if (!weeklyGoals || typeof weeklyGoals !== "object") {
        return res.status(400).json({ error: "weeklyGoals object is required" });
      }
      await peopleStorage.saveTimeBudgets({ weeklyGoals });
      res.json({ weeklyGoals });
    } catch (error: any) {
      log.error(`PUT /api/people/time-budgets error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/agenda", async (_req, res) => {
    log.debug(`GET /api/people/agenda`);
    try {
      const { computeAgendaSignals, computeContextBadge } = await import("./people-storage");
      const people = await peopleStorage.listPeople();
      const cabinetConfig = await peopleStorage.getCabinetConfig();
      const now = Date.now();

      const cabinetWeights: Record<string, number> = {};
      for (const level of cabinetConfig.levels) {
        cabinetWeights[level.id] = Math.max(1, 7 - level.order);
      }

      let calendarAttendees: Set<string> | undefined;
      try {
        const { listAllEvents } = await import("./google-calendar");
        const { getTzOffsetISO, getTzDateStr } = await import("./timezone");
        const tz = (await import("./timezone")).getTimezone();
        const offset = getTzOffsetISO(tz);
        const todayStr = getTzDateStr(tz);
        const weekEnd = new Date(new Date(todayStr + "T12:00:00").getTime() + 7 * 86400000);
        const endStr = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`;
        const { events } = await listAllEvents({
          timeMin: `${todayStr}T00:00:00${offset}`,
          timeMax: `${endStr}T23:59:59${offset}`,
          maxResults: 100,
        });
        calendarAttendees = new Set<string>();
        for (const ev of events) {
          if (ev.attendees) {
            for (const a of ev.attendees) {
              if (a.displayName) calendarAttendees.add(a.displayName.toLowerCase());
              if (a.email) calendarAttendees.add(a.email.toLowerCase());
            }
          }
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn(`GET /api/people/agenda calendar attendee enrichment degraded: ${msg}`);
      }

      const commitments: import("./people-storage").ScoredAgendaItem[] = [];
      const nurture: import("./people-storage").ScoredAgendaItem[] = [];
      const invest: import("./people-storage").ScoredAgendaItem[] = [];
      const candidateEntries = people.filter(entry => entry.cabinetLevel !== "self" && entry.cabinetLevel !== "agent" && entry.cabinetLevel !== "user" && entry.cabinetLevel !== "network");
      const fullPeople = await peopleStorage.getPeopleByIds(candidateEntries.map(entry => entry.id));
      const peopleById = new Map(fullPeople.map(person => [person.id, person]));

      for (const entry of candidateEntries) {
        const person = peopleById.get(entry.id);
        if (!person) continue;
        const item = computeAgendaSignals(person, cabinetWeights, now, calendarAttendees);
        if (!item) continue;

        if (item.bucket === "commitment") commitments.push(item);
        else if (item.bucket === "invest") invest.push(item);
        else nurture.push(item);
      }

      commitments.sort((a, b) => b.score - a.score);
      invest.sort((a, b) => b.score - a.score);
      nurture.sort((a, b) => b.score - a.score);

      const strip = (items: import("./people-storage").ScoredAgendaItem[]) =>
        items.map(({ score, bucket, signals, ...item }) => ({
          ...item,
          surfaceRank: score,
          contextBadge: computeContextBadge({ ...item, score, bucket, signals } as import("./people-storage").ScoredAgendaItem),
        }));

      res.json({
        commitments: strip(commitments),
        invest: strip(invest),
        nurture: strip(nurture),
        agenda: strip([...commitments, ...invest, ...nurture].sort((a, b) => b.score - a.score)),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`GET /api/people/agenda error:`, msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/people/email-map", async (_req, res) => {
    log.debug(`GET /api/people/email-map`);
    try {
      const people = await peopleStorage.listPeople();
      const fullPeople = await peopleStorage.getPeopleByIds(people.map(entry => entry.id));
      const emailMap: Record<string, { id: string; name: string }> = {};
      for (const person of fullPeople) {
        for (const ci of person.contactInfo || []) {
          if (ci.type === "email" && ci.value) {
            emailMap[ci.value.toLowerCase()] = { id: person.id, name: person.name };
          }
        }
      }
      res.json({ emailMap });
    } catch (error: any) {
      log.error(`GET /api/people/email-map error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people", async (_req, res) => {
    log.debug(`GET /api/people`);
    try {
      const people = await peopleStorage.listPeople();
      res.json({ people });
    } catch (error: any) {
      log.error(`GET /api/people error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people", async (req, res) => {
    log.log(`POST /api/people name=${req.body.name}`);
    try {
      const { name, cabinetLevel } = req.body;
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required" });
      }
      if (!cabinetLevel || typeof cabinetLevel !== "string") {
        return res.status(400).json({ error: "cabinetLevel is required" });
      }
      const person = await peopleStorage.createPerson({
        name,
        cabinetLevel,
        nicknames: req.body.nicknames || [],
        photo: req.body.photo,
        birthday: req.body.birthday,
        company: req.body.company,
        role: req.body.role,
        professionalRelations: req.body.professionalRelations || [],
        relation: req.body.relation,
        introducedBy: req.body.introducedBy,
        familiarity: req.body.familiarity,
        trust: req.body.trust,
        met: req.body.met,
        socialProfiles: req.body.socialProfiles || {},
        contactInfo: req.body.contactInfo || [],
        importantDates: req.body.importantDates || [],
        notes: req.body.notes || [],
        interactions: req.body.interactions || [],
        tags: req.body.tags || [],
        private: req.body.private ?? false,
      });
      res.json(person);
    } catch (error: any) {
      log.error(`POST /api/people error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/:id", async (req, res) => {
    log.debug(`GET /api/people/${req.params.id}`);
    try {
      const person = await peopleStorage.getPerson(req.params.id);
      if (!person) {
        return res.status(404).json({ error: "Person not found" });
      }
      res.json(person);
    } catch (error: any) {
      log.error(`GET /api/people/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people/:id/viewed", async (req, res) => {
    log.debug(`POST /api/people/${req.params.id}/viewed`);
    try {
      await peopleStorage.markViewed(req.params.id);
      res.json({ ok: true });
    } catch (error: any) {
      log.error(`POST /api/people/${req.params.id}/viewed error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/people/:id", async (req, res) => {
    log.log(`PATCH /api/people/${req.params.id} fields=${Object.keys(req.body).join(",")}`);
    try {
      if (Array.isArray(req.body.tags)) {
        for (const tag of req.body.tags) {
          await tagRegistry.ensureTag(tag);
        }
      }
      const person = await peopleStorage.updatePerson(req.params.id, req.body);
      if (Array.isArray(req.body.tags)) {
        await tagRegistry.setEntityTags("person", person.id, person.name, person.tags || []).catch(err => log.warn("tag sync failed", err));
      }
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`PATCH /api/people/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/people/:id", async (req, res) => {
    log.log(`DELETE /api/people/${req.params.id}`);
    try {
      await peopleStorage.deletePerson(req.params.id);
      res.json({ message: "Person deleted" });
    } catch (error: any) {
      log.error(`DELETE /api/people/${req.params.id} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people/:id/notes", async (req, res) => {
    log.log(`POST /api/people/${req.params.id}/notes`);
    try {
      const { content, title } = req.body;
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }
      const person = await peopleStorage.addNote(req.params.id, content, title);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`POST /api/people/${req.params.id}/notes error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/people/:id/notes/:noteId", async (req, res) => {
    log.log(`PATCH /api/people/${req.params.id}/notes/${req.params.noteId}`);
    try {
      const { content, title } = req.body;
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }
      const person = await peopleStorage.updateNote(req.params.id, req.params.noteId, content, title);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`PATCH /api/people/${req.params.id}/notes/${req.params.noteId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/people/:id/notes/:noteId", async (req, res) => {
    log.log(`DELETE /api/people/${req.params.id}/notes/${req.params.noteId}`);
    try {
      const person = await peopleStorage.deleteNote(req.params.id, req.params.noteId);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`DELETE /api/people/${req.params.id}/notes/${req.params.noteId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });


  app.post("/api/people/:id/interactions", async (req, res) => {
    log.log(`POST /api/people/${req.params.id}/interactions type=${req.body.type}`);
    try {
      const { date, type, summary, context } = req.body;
      if (!date || typeof date !== "string") {
        return res.status(400).json({ error: "date is required" });
      }
      if (!type || typeof type !== "string") {
        return res.status(400).json({ error: "type is required" });
      }
      if (!summary || typeof summary !== "string") {
        return res.status(400).json({ error: "summary is required" });
      }
      const validTypes = ["message", "call", "meeting", "meetup", "email", "note", "text", "in_person", "video", "social", "gift", "introduction", "favor", "support"];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
      }
      const interaction: any = { date, type, summary };
      if (context && typeof context === "string") interaction.context = context;
      if (req.body.direction) {
        const validDirections = ["inbound", "outbound", "mutual"];
        if (!validDirections.includes(req.body.direction)) return res.status(400).json({ error: `direction must be one of: ${validDirections.join(", ")}` });
        interaction.direction = req.body.direction;
      }
      if (req.body.meaningfulness) {
        const validMeaningfulness = ["low", "medium", "high"];
        if (!validMeaningfulness.includes(req.body.meaningfulness)) return res.status(400).json({ error: `meaningfulness must be one of: ${validMeaningfulness.join(", ")}` });
        interaction.meaningfulness = req.body.meaningfulness;
      }
      if (req.body.responseOwed !== undefined) interaction.responseOwed = req.body.responseOwed;
      if (req.body.responseDueBy) interaction.responseDueBy = req.body.responseDueBy;
      if (req.body.capitalImpact) interaction.capitalImpact = req.body.capitalImpact;
      if (req.body.tags) interaction.tags = req.body.tags;
      const person = await peopleStorage.addInteraction(req.params.id, interaction);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`POST /api/people/${req.params.id}/interactions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/people/:id/interactions/:interactionId", async (req, res) => {
    log.log(`PATCH /api/people/${req.params.id}/interactions/${req.params.interactionId}`);
    try {
      const { summary, context, type, direction, meaningfulness, responseOwed, responseDueBy, capitalImpact, tags: interactionTags } = req.body;
      const updates: Record<string, any> = {};
      if (summary !== undefined) updates.summary = summary;
      if (context !== undefined) updates.context = context;
      if (type !== undefined) {
        const validTypes = ["message", "call", "meeting", "meetup", "email", "note", "text", "in_person", "video", "social", "gift", "introduction", "favor", "support"];
        if (!validTypes.includes(type)) {
          return res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
        }
        updates.type = type;
      }
      if (direction !== undefined) updates.direction = direction;
      if (meaningfulness !== undefined) updates.meaningfulness = meaningfulness;
      if (responseOwed !== undefined) updates.responseOwed = responseOwed;
      if (responseDueBy !== undefined) updates.responseDueBy = responseDueBy;
      if (capitalImpact !== undefined) updates.capitalImpact = capitalImpact;
      if (interactionTags !== undefined) updates.tags = interactionTags;
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No update fields provided" });
      }
      const person = await peopleStorage.updateInteraction(req.params.id, req.params.interactionId, updates);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`PATCH /api/people/${req.params.id}/interactions/${req.params.interactionId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/people/:id/interactions", async (req, res) => {
    log.log(`DELETE /api/people/${req.params.id}/interactions (clear all)`);
    try {
      const person = await peopleStorage.clearInteractions(req.params.id);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`DELETE /api/people/${req.params.id}/interactions error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/people/:id/interactions/:interactionId", async (req, res) => {
    log.log(`DELETE /api/people/${req.params.id}/interactions/${req.params.interactionId}`);
    try {
      const person = await peopleStorage.deleteInteraction(req.params.id, req.params.interactionId);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`DELETE /api/people/${req.params.id}/interactions/${req.params.interactionId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people/:id/dates", async (req, res) => {
    log.log(`POST /api/people/${req.params.id}/dates label=${req.body.label}`);
    try {
      const { label, date, recurrence } = req.body;
      if (!label || typeof label !== "string") {
        return res.status(400).json({ error: "label is required" });
      }
      if (!date || typeof date !== "string") {
        return res.status(400).json({ error: "date is required" });
      }
      if (!recurrence || !["annual", "one-time"].includes(recurrence)) {
        return res.status(400).json({ error: "recurrence must be 'annual' or 'one-time'" });
      }
      const person = await peopleStorage.addDate(req.params.id, { label, date, recurrence });
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`POST /api/people/${req.params.id}/dates error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/people/:id/dates/:dateId", async (req, res) => {
    log.log(`PATCH /api/people/${req.params.id}/dates/${req.params.dateId}`);
    try {
      const person = await peopleStorage.updateDate(req.params.id, req.params.dateId, req.body);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`PATCH /api/people/${req.params.id}/dates/${req.params.dateId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/people/:id/dates/:dateId", async (req, res) => {
    log.log(`DELETE /api/people/${req.params.id}/dates/${req.params.dateId}`);
    try {
      const person = await peopleStorage.deleteDate(req.params.id, req.params.dateId);
      res.json(person);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      log.error(`DELETE /api/people/${req.params.id}/dates/${req.params.dateId} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/trust-config", async (_req, res) => {
    log.debug(`GET /api/trust-config`);
    try {
      const config = await peopleStorage.getTrustConfig();
      res.json(config);
    } catch (error: any) {
      log.error(`GET /api/trust-config error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/trust-config", async (req, res) => {
    log.log(`PUT /api/trust-config`);
    try {
      const { levels } = req.body;
      if (!levels || typeof levels !== "object") {
        return res.status(400).json({ error: "levels object is required" });
      }
      await peopleStorage.saveTrustConfig({ levels });
      res.json({ levels });
    } catch (error: any) {
      log.error(`PUT /api/trust-config error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/:id/identity", async (req, res) => {
    log.debug(`GET /api/people/${req.params.id}/identity`);
    try {
      const person = await peopleStorage.getPerson(req.params.id);
      if (!person) {
        return res.status(404).json({ error: "Person not found" });
      }
      res.json({ identityContent: person.identityContent || "" });
    } catch (error: any) {
      log.error(`GET /api/people/${req.params.id}/identity error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/people/:id/identity", async (req, res) => {
    log.log(`PUT /api/people/${req.params.id}/identity`);
    try {
      const { identityContent } = req.body;
      if (typeof identityContent !== "string") {
        return res.status(400).json({ error: "identityContent string is required" });
      }
      const person = await peopleStorage.updateIdentityContent(req.params.id, identityContent);
      res.json({ identityContent: person.identityContent || "" });
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people/migrate-identity", async (_req, res) => {
    log.log(`POST /api/people/migrate-identity`);
    try {
      const result = await peopleStorage.migrateIdentityFromDocuments();
      res.json(result);
    } catch (error: any) {
      log.error(`POST /api/people/migrate-identity error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/people/:id/summarize", async (req, res) => {
    log.log(`POST /api/people/${req.params.id}/summarize`);
    try {
      const person = await peopleStorage.getPerson(req.params.id);
      if (!person) {
        return res.status(404).json({ error: "Person not found" });
      }

      const interactionSummaries = (person.interactions || [])
        .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 50)
        .map((i: any) => `[${i.date}] ${i.type}: ${i.summary}${i.context ? ` (${i.context})` : ""}`)
        .join("\n");

      const notesText = (person.notes || [])
        .map((n: any) => `[${n.updatedAt || n.date || ""}] ${n.content}`)
        .join("\n");

      const identityText = person.identityContent || "";

      let linkedMemoriesText = "";
      try {
        const personNames = [person.name, ...(person.nicknames || [])];
        const allMemories: Array<{ id: number; title: string | null; summary: string | null; content: string }> = [];
        for (const name of personNames) {
          if (name && name.trim()) {
            const results = await unifiedMemorySearch({ query: name.trim(), limit: 15 });
            allMemories.push(...results.map(r => r.entry));
          }
        }
        const uniqueMemories = Array.from(new Map(allMemories.map(m => [m.id, m])).values());
        if (uniqueMemories.length > 0) {
          linkedMemoriesText = uniqueMemories
            .slice(0, 20)
            .map(m => `[Memory #${m.id}] ${m.title || "(untitled)"}: ${m.summary || m.content?.slice(0, 200) || ""}`)
            .join("\n");
        }
      } catch (e: unknown) {
        log.error(`error fetching linked memories for summarize:`, e instanceof Error ? e.message : String(e));
      }

      const { getUserName } = await import("./context-assembly");
      const ownerName = await getUserName();

      const context = [
        `Dashboard owner: ${ownerName}`,
        `\n--- PERSON DETAILS ---`,
        `Name: ${person.name}`,
        person.nicknames?.length ? `Also known as: ${person.nicknames.join(", ")}` : null,
        person.company ? `Company: ${person.company}` : null,
        person.role ? `Role: ${person.role}` : null,
        person.relation ? `Relation to ${ownerName}: ${person.relation}` : null,
        person.professionalRelations?.length ? `Professional Relations: ${person.professionalRelations.join(", ")}` : null,
        person.cabinetLevel ? `Closeness Level: ${person.cabinetLevel}` : null,
        person.familiarity ? `Familiarity: ${person.familiarity}` : null,
        person.trust ? `Trust Level: ${person.trust}` : null,
        person.met ? `How they met: ${person.met}` : null,
        person.birthday ? `Birthday: ${person.birthday}` : null,
        person.tags?.length ? `Tags: ${person.tags.join(", ")}` : null,
        person.introducedBy ? `Introduced by: ${person.introducedBy}` : null,
        identityText ? `\n--- IDENTITY / DEEP PROFILE ---\n${identityText}` : null,
        notesText ? `\n--- NOTES ---\n${notesText}` : null,
        interactionSummaries ? `\n--- INTERACTION HISTORY (${(person.interactions || []).length} total, showing recent) ---\n${interactionSummaries}` : null,
        linkedMemoriesText ? `\n--- LINKED MEMORIES ---\n${linkedMemoriesText}` : null,
      ].filter(Boolean).join("\n");

      const deepSpine = await contextBuilder.resolve({ callType: 'world', llmMode: 'text' });
      const deepSpineContext = contextBuilder.renderToPrompt(deepSpine);
      const deepSystemPrompt = (await getPromptModulePrompt("people-deepsummary")) + `\n\nContext: You are writing for ${ownerName}'s personal dashboard about ${person.name}. Always refer to the dashboard owner as "${ownerName}" by name — never say "the user" or "the individual".`;
      const deepMessages = [
        {
          role: "system" as const,
          content: deepSpineContext ? `${deepSpineContext}\n\n${deepSystemPrompt}` : deepSystemPrompt,
        },
        {
          role: "user" as const,
          content: context,
        },
      ];
      const summaryResult = await chatCompletion({
        activity: ACTIVITY_FRAMING,
        maxTokens: 2000,
        messages: deepMessages,
        metadata: { source: "people-deep-summary", toolName: "people.summarize", activity: ACTIVITY_FRAMING },
      });

      const summary = summaryResult.content.trim() || "Unable to generate summary.";
      await peopleStorage.updatePerson(req.params.id, { aiSummary: summary });
      res.json({ summary });
    } catch (error: any) {
      log.error(`POST /api/people/${req.params.id}/summarize error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/people/:id/relationship-memories", async (req, res) => {
    try {
      const { documentStorage } = await import("./memory");
      const docs = await documentStorage.getDocumentsByType("memory");
      const personTag = `rm:${req.params.id}`;
      const memories = docs.filter(d => {
        const meta = d.metadata as Record<string, unknown> | null;
        const tags: string[] = Array.isArray(meta?.tags) ? (meta.tags as string[]) : [];
        return tags.includes(personTag);
      });

      const result = memories.map(d => {
        const meta = d.metadata as Record<string, unknown> | null;
        const tags: string[] = Array.isArray(meta?.tags) ? (meta.tags as string[]) : [];
        const category = tags.find((t: string) => t.startsWith("rm-cat:"))?.replace("rm-cat:", "") || "uncategorized";
        return {
          id: d.docId,
          title: d.title,
          content: d.content,
          category,
          tags,
          createdAt: (meta?.createdAt as string) || null,
          personName: (meta?.personName as string) || null,
        };
      });

      result.sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`GET /api/people/${req.params.id}/relationship-memories error:`, msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/people/:id/relationship-memories", async (req, res) => {
    try {
      const person = await peopleStorage.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: "Person not found" });

      const { content, category } = req.body;
      if (!content || typeof content !== "string") return res.status(400).json({ error: "Missing content" });

      const validCategories = ["dynamic", "preference", "channel", "expertise", "network", "capital", "risk", "repair", "ritual", "opportunity"];
      if (!category || !validCategories.includes(category)) {
        return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
      }

      const { documentStorage } = await import("./memory");
      const nowIso = new Date().toISOString();
      const tags = ["relationship-model", `rm:${req.params.id}`, `rm-cat:${category}`];
      const doc = await documentStorage.createDocument({
        docType: "memory",
        title: `${person.name} — ${category}`,
        content,
        metadata: { tags, source: "manual", personId: req.params.id, personName: person.name, createdAt: nowIso },
      });

      res.status(201).json({
        id: doc.docId,
        title: doc.title,
        content: doc.content,
        category,
        tags,
        createdAt: nowIso,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`POST /api/people/${req.params.id}/relationship-memories error:`, msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/people/:id/enrichment-prompts", async (req, res) => {
    try {
      const person = await peopleStorage.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: "Person not found" });

      const np = person.networkProfile;
      const rp = person.relationshipProfile;
      const missing: string[] = [];
      if (!np?.expertise?.length) missing.push("expertise");
      if (!np?.domains?.length) missing.push("domains");
      if (!np?.connections?.length) missing.push("connections");
      if (!np?.canHelpWith?.length) missing.push("canHelpWith");
      if (!np?.capital) missing.push("capital");
      if (!rp?.state?.temperature) missing.push("temperature");
      if (!rp?.cadence) missing.push("cadence");

      if (missing.length === 0) {
        return res.json({ complete: true, missing: [], prompts: [] });
      }

      const prompts: { field: string; question: string }[] = [];
      if (missing.includes("expertise")) prompts.push({ field: "expertise", question: `What is ${person.name}'s professional expertise? What are they especially good at?` });
      if (missing.includes("domains")) prompts.push({ field: "domains", question: `What industries or domains does ${person.name} work in?` });
      if (missing.includes("connections")) prompts.push({ field: "connections", question: `Who does ${person.name} know? What notable connections do they have?` });
      if (missing.includes("canHelpWith")) prompts.push({ field: "canHelpWith", question: `What could ${person.name} specifically help you with if you needed something?` });
      if (missing.includes("capital")) prompts.push({ field: "capital", question: `How would you describe the balance of favors between you and ${person.name}?` });
      if (missing.includes("temperature")) prompts.push({ field: "temperature", question: `How warm is your relationship with ${person.name} right now?` });
      if (missing.includes("cadence")) prompts.push({ field: "cadence", question: `How often do you typically stay in touch with ${person.name}?` });

      res.json({ complete: false, missing, prompts });
    } catch (error: any) {
      log.error(`GET /api/people/${req.params.id}/enrichment-prompts error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });
}
