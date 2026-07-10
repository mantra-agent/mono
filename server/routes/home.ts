import type { Express } from "express";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { eventBus } from "../event-bus";
import { fileTaskStorage } from "../file-storage/tasks";
import { listAllEvents, type CalendarEvent } from "../google-calendar";
import { logWellnessActivity } from "./wellness";
import { generateSimpleFeed, invalidateSimpleFeedCache } from "../simple/generate-feed";
import { goalsService } from "../goals-service";
import { dismissPeopleSurface, snoozePeopleSurface } from "../simple/people-surface-state";
import type { GoalHorizon, GoalIndexEntry } from "@shared/models/goals";
import type { Task } from "@shared/models/work";

const log = createLogger("SimpleRoutes");

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

type PlanCadence = "daily" | "weekly" | "monthly" | "quarterly";


function localDate(now = new Date(), timezone = "America/Chicago"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function endOfWeek(today: string, timezone = "America/Chicago"): string {
  const d = new Date(`${today}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).formatToParts(d);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const current = weekdayMap[parts.find(p => p.type === "weekday")?.value ?? "Mon"] ?? 1;
  const daysUntilSunday = (7 - current) % 7 || 7;
  return addDays(today, daysUntilSunday);
}

function endOfMonth(today: string): string {
  const [year, month] = today.split("-").map(Number);
  const last = new Date(year, month, 0).getDate();
  return `${today.slice(0, 8)}${String(last).padStart(2, "0")}`;
}

function endOfQuarter(today: string): string {
  const [year, month] = today.split("-").map(Number);
  const qEnd = Math.ceil(month / 3) * 3;
  const last = new Date(year, qEnd, 0).getDate();
  return `${year}-${String(qEnd).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function isoWeekString(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function intervalForCadence(cadence: PlanCadence, timezone = "America/Chicago"): { start: string; end: string } {
  const today = localDate(new Date(), timezone);
  if (cadence === "daily") return { start: today, end: today };
  if (cadence === "weekly") return { start: today, end: endOfWeek(today, timezone) };
  if (cadence === "monthly") return { start: today, end: endOfMonth(today) };
  return { start: today, end: endOfQuarter(today) };
}

function formatEventTime(event: CalendarEvent, timezone = "America/Chicago"): string {
  const raw = event.start?.dateTime || event.start?.date || "";
  if (!raw) return "";
  if (!event.start?.dateTime) return "all day";
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(new Date(raw));
}

function meetingRef(event: CalendarEvent): string {
  const id = [event.accountId, event.calendarId, event.id].map(encodeURIComponent).join("~");
  return `@meeting:${id}`;
}

function compactList<T>(items: T[], render: (item: T) => string, empty: string): string {
  if (!items.length) return empty;
  const rendered = items.slice(0, 5).map(render);
  const extra = items.length > rendered.length ? `, +${items.length - rendered.length} more` : "";
  return `${rendered.join(", ")}${extra}`;
}

async function getParentGoalsForPlan(cadence: PlanCadence): Promise<GoalIndexEntry[]> {
  const today = localDate();
  if (cadence === "daily") return goalsService.listAll({ horizon: "this_week", periodWeek: isoWeekString(today), periodScoped: true });
  if (cadence === "weekly") return goalsService.listAll({ horizon: "this_month", periodMonth: today.slice(0, 7), periodScoped: true });
  if (cadence === "monthly") return goalsService.listAll({ horizon: "this_quarter" });
  return goalsService.listAll({ horizon: "this_year" });
}

async function buildPlanOpeningContext(cadence: PlanCadence): Promise<string> {
  const timezone = "America/Chicago";
  const { start, end } = intervalForCadence(cadence, timezone);
  const [calendarResult, tasks, parentGoals] = await Promise.all([
    listAllEvents({ timeMin: `${start}T00:00:00-05:00`, timeMax: `${end}T23:59:59-05:00`, maxResults: 25 }).catch(err => {
      log.warn(`plan opening calendar failed: ${err instanceof Error ? err.message : String(err)}`);
      return { events: [], errors: [] };
    }),
    fileTaskStorage.getTasks({ owner: "me" }).catch(err => {
      log.warn(`plan opening tasks failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as Task[];
    }),
    getParentGoalsForPlan(cadence).catch(err => {
      log.warn(`plan opening parent goals failed: ${err instanceof Error ? err.message : String(err)}`);
      return [] as GoalIndexEntry[];
    }),
  ]);

  const events = calendarResult.events
    .filter(e => e.status !== "cancelled")
    .filter(e => {
      const eventDate = (e.start?.dateTime || e.start?.date || "").slice(0, 10);
      return eventDate >= start && eventDate <= end;
    });
  const dueTasks = tasks
    .filter(t => t.status !== "done" && t.deadline && t.deadline >= start && t.deadline <= end);
  const activeParentGoals = parentGoals.filter(g => g.status !== "achieved");

  const eventLine = compactList(events, e => `${meetingRef(e)}${formatEventTime(e, timezone) ? ` (${formatEventTime(e, timezone)})` : ""}`, "none");
  const taskLine = compactList(dueTasks, t => `@task:${t.id}`, "none");
  const goalLine = compactList(activeParentGoals, g => `@goal:${g.id}`, "none set");
  return `Current commitments (${start}${start === end ? "" : ` to ${end}`}): Events: ${eventLine}. Tasks due: ${taskLine}. Parent goals: ${goalLine}.`;
}

function planCadenceValue(value: unknown): PlanCadence | null {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "quarterly" ? value : null;
}

async function buildParameterizedPlanPreContext(cadence: PlanCadence): Promise<string | undefined> {
  const now = new Date();
  const targetHorizon = cadence === "daily" ? "today" : cadence === "weekly" ? "this_week" : cadence === "monthly" ? "this_month" : "this_quarter";
  const parentHorizon = cadence === "daily" ? "this_week" : cadence === "weekly" ? "this_month" : cadence === "monthly" ? "this_quarter" : "this_year";
  const periodField = cadence === "daily" ? "periodDate" : cadence === "weekly" ? "periodWeek" : cadence === "monthly" ? "periodMonth" : "periodQuarter";
  const month = now.getMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const targetLabel = cadence === "daily"
    ? new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    : cadence === "weekly"
      ? new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
      : cadence === "monthly"
      ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(now)
      : `Q${quarter} ${now.getFullYear()}`;

  const contract = [
    `# Parameterized Plan Request`,
    `cadence: ${cadence}`,
    `targetLabel: ${targetLabel}`,
    `targetHorizon: ${targetHorizon}`,
    `parentHorizon: ${parentHorizon}`,
    `periodField: ${periodField}`,
    `artifactPurpose: Home/Simple ${cadence} plan generation`,
    `surfacePolicy: always`,
  ].join("\n");

  return [
    contract,
    "conversationMode: true",
    "firstTurnInstruction: Start a short conversation. Do not create goals, create a Library artifact, or call priorities metadata until Ray confirms the goal set.",
    "contextPolicy: Use only parent goals, existing target-period goals, and future calendar/project constraints if needed. Do not load past reflections or finance transactions unless Ray explicitly asks.",
  ].join("\n");
}

function periodToHorizon(period: string): GoalHorizon | null {
  if (period === "daily" || period === "next_day" || period === "today") return "today";
  if (period === "weekly" || period === "next_week" || period === "this_week") return "this_week";
  if (period === "monthly" || period === "next_month" || period === "this_month") return "this_month";
  if (period === "this_quarter") return "this_quarter";
  if (period === "this_year") return "this_year";
  if (period === "three_year") return "three_year";
  if (period === "ten_year") return "ten_year";
  if (period === "lifetime") return "lifetime";
  return null;
}

async function completePriority(payload: Record<string, unknown>) {
  const period = stringValue(payload.period);
  const date = stringValue(payload.date);
  const title = stringValue(payload.title);
  const priorityId = stringValue(payload.priorityId);
  const horizon = period ? periodToHorizon(period) : null;

  if (!period || !horizon || (!title && !priorityId)) {
    const missing = [!period && "period", !horizon && "valid period", !title && !priorityId && "title or priorityId"].filter(Boolean).join(", ");
    const err = new Error(`Missing priority completion fields: ${missing}`);
    (err as any).statusCode = 400;
    throw err;
  }

  // If we have a priorityId (goal ID), update directly
  if (priorityId) {
    const goal = await goalsService.get(priorityId);
    if (!goal) {
      const err = new Error("Priority not found");
      (err as any).statusCode = 404;
      throw err;
    }
    await goalsService.setStatus(priorityId, "achieved");
    eventBus.publish({ category: "goals", event: "goal:completed", payload: { goalId: priorityId, horizon } });
    return { ok: true, type: "priority", date, horizon, title: goal.shortName };
  }

  // Fallback: find by title in the period
  const result = await goalsService.markPriorityStatus(title!, "completed", horizon, date);
  if ("error" in result) {
    const err = new Error(result.error);
    (err as any).statusCode = 404;
    throw err;
  }

  eventBus.publish({ category: "goals", event: "goal:completed", payload: { goalId: result.updated.id, horizon } });
  return { ok: true, type: "priority", date, horizon, title: result.updated.shortName };
}

async function completeWellness(payload: Record<string, unknown>) {
  const activityId = numberValue(payload.activityId);
  if (!activityId) {
    const err = new Error("activityId is required");
    (err as any).statusCode = 400;
    throw err;
  }

  const result = await logWellnessActivity(activityId);
  if ("duplicate" in result) return { ok: true, type: "wellness", activityId, duplicate: true };
  return { ok: true, type: "wellness", activityId, logId: result.id };
}

async function completeTask(payload: Record<string, unknown>) {
  const taskId = numberValue(payload.taskId);
  if (!taskId) {
    const err = new Error("taskId is required");
    (err as any).statusCode = 400;
    throw err;
  }

  const task = await fileTaskStorage.updateTask(taskId, { status: "done" });
  if (!task) {
    const err = new Error(`Task ${taskId} not found`);
    (err as any).statusCode = 404;
    throw err;
  }

  return { ok: true, type: "task", taskId, title: task.title };
}

export function registerHomeRoutes(app: Express) {
  app.get("/api/home/feed", requireAuth, async (req, res) => {
    try {
      const refresh = req.query.refresh === "true";
      const useModel = req.query.model === "true";
      const accountId = req.principal?.accountId || "";
      const feed = await generateSimpleFeed({ refresh, useModel, accountId });
      res.json(feed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`GET /api/home/feed failed: ${message}`);
      res.status(500).json({ error: message, operation: "get_home_feed" });
    }
  });

  app.post("/api/home/run-plan-skill", requireAuth, async (req, res) => {
    const skillName = typeof req.body?.skillName === "string" ? req.body.skillName.trim() : "";
    const cadence = planCadenceValue(req.body?.cadence);
    if (skillName !== "plan" || !cadence) {
      return res.status(400).json({ error: `Invalid plan request: skill=${skillName || "(missing)"}, cadence=${String(req.body?.cadence ?? "(missing)")}. Expected skill=plan and cadence=daily|weekly|monthly|quarterly` });
    }
    try {
      const topic = cadence === "daily" ? "Daily Plan" : cadence === "weekly" ? "Weekly Plan" : cadence === "monthly" ? "Monthly Plan" : "Quarterly Plan";
      const preContext = await buildParameterizedPlanPreContext(cadence);
      const { getSkillProcess } = await import("../skill-seed");
      const skillProcess = await getSkillProcess("plan");
      const skillContext = [
        "[SKILL — Plan]",
        "",
        preContext,
        "",
        skillProcess,
      ].join("\n");
      const openingContext = await buildPlanOpeningContext(cadence);
      const openingPrompt = cadence === "daily"
        ? "Let’s align today’s goals. I’ll use the weekly goals as the parent frame and keep this short. What should the three daily goals be?"
        : cadence === "weekly"
          ? "Let’s align this week’s goals. I’ll use the monthly goals as the parent frame and keep this short. What should the three weekly goals be?"
        : cadence === "monthly"
            ? "Let’s align this month’s goals. I’ll use the quarterly goals as the parent frame and keep this short. What should the three monthly goals be?"
          : "Let’s align this quarter’s goals. I’ll use the yearly goals as the parent frame and keep this short. What should the three quarterly goals be?";
      const openingMessage = `${openingContext}\n\n${openingPrompt}`;

      const { chatFileStorage } = await import("../chat-file-storage");
      const created = await chatFileStorage.createAutonomousSession(
        topic,
        "agent",
        undefined,
        undefined,
        undefined,
        { spawnReason: `home-plan:${cadence}`, spawnerTool: "home.run-plan-skill", triggerType: "agent" as const, triggerName: topic },
      );
      await chatFileStorage.createMessage(created.id, "system_prompt", skillContext);
      await chatFileStorage.setInitialContext(created.id, skillContext);
      await chatFileStorage.updateSessionContextFlags(created.id, {
        "world_model.people.partner.goals": true,
        "world_model.active_work": true,
        "world_model.decisions": true,
        "memory": false,
        "world_model.people.others": false,
        "world_model.people.self.principles": false,
      });
      await chatFileStorage.createMessage(created.id, "assistant", openingMessage);
      await chatFileStorage.setSessionPinned(created.id, true);
      await chatFileStorage.saveSession(created.id, topic);
      eventBus.publish({
        category: "chat",
        event: "chat.xyz.initiated",
        payload: { sessionId: created.id, topic, source: "home-plan", cadence },
      });
      invalidateSimpleFeedCache();
      res.json({ success: true, sessionId: created.id, skillName: "plan", cadence });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`POST /api/home/run-plan-skill failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  app.patch("/api/home/people/:personId/surface", requireAuth, async (req, res) => {
    const personId = stringValue(req.params.personId);
    const action = stringValue(req.body?.action);
    try {
      if (!personId) return res.status(400).json({ error: "personId is required" });
      if (action === "dismiss") {
        const reasonKey = stringValue(req.body?.reasonKey);
        if (!reasonKey) return res.status(400).json({ error: "reasonKey is required" });
        const state = await dismissPeopleSurface(personId, reasonKey);
        invalidateSimpleFeedCache(req.principal?.accountId || undefined);
        return res.json({ ok: true, personId, state });
      }
      if (action === "snooze") {
        const reasonKey = stringValue(req.body?.reasonKey);
        const rawUntil = stringValue(req.body?.snoozedUntil);
        if (!reasonKey) return res.status(400).json({ error: "reasonKey is required" });
        if (!rawUntil) return res.status(400).json({ error: "snoozedUntil is required" });
        const snoozedUntil = new Date(rawUntil);
        if (Number.isNaN(snoozedUntil.getTime())) return res.status(400).json({ error: "Invalid snoozedUntil" });
        const state = await snoozePeopleSurface(personId, reasonKey, snoozedUntil);
        invalidateSimpleFeedCache(req.principal?.accountId || undefined);
        return res.json({ ok: true, personId, state });
      }
      return res.status(400).json({ error: "action must be dismiss or snooze" });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      log.error(`PATCH /api/home/people/${personId}/surface failed: ${message}`);
      res.status(status).json({ error: message, operation: "update_home_people_surface" });
    }
  });

  app.post("/api/home/items/:id/complete", requireAuth, async (req, res) => {
    try {
      const sourceType = stringValue(req.body?.sourceType);
      const payload = (req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : {}) as Record<string, unknown>;
      const result = sourceType === "wellness"
        ? await completeWellness(payload)
        : sourceType === "priority" || sourceType === "goal"
          ? await completePriority(payload)
          : sourceType === "task"
            ? await completeTask(payload)
            : null;

      if (!result) return res.status(400).json({ error: "sourceType must be wellness, priority, goal, or task" });
      invalidateSimpleFeedCache();
      res.json(result);
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      log.error(`POST /api/home/items/${req.params.id}/complete failed: ${message}`);
      res.status(status).json({ error: message, operation: "complete_home_item" });
    }
  });
}
