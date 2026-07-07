// Use createLogger for logging ONLY
import type { Express } from "express";
import { getDateInTimezone } from "../timezone";
import { getSecretSync } from "../secrets-store";
import { goalsService } from "../goals-service";

function getMondayOfCurrentWeek(): string {
  const today = getDateInTimezone();
  const d = new Date(today + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

function getMondayOfNextWeek(): string {
  const today = getDateInTimezone();
  const d = new Date(today + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff + 7);
  const mm = String(monday.getMonth() + 1).padStart(2, "0");
  const dd = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${mm}-${dd}`;
}

function getFirstOfCurrentMonth(): string {
  const today = getDateInTimezone();
  const d = new Date(today + "T12:00:00");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-01`;
}

function getTomorrowDate(): string {
  const today = getDateInTimezone();
  const d = new Date(today + "T12:00:00");
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function getFirstOfNextMonth(): string {
  const today = getDateInTimezone();
  const d = new Date(today + "T12:00:00");
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  return `${next.getFullYear()}-${mm}-01`;
}

export function registerGoalRoutes(app: Express) {
  app.get("/api/goals/agent/status", async (_req, res) => {
    try {
      const { getAgentStatus } = await import("../elevenlabs");
      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (!agentId) {
        return res.json({ configured: false, agentId: null });
      }
      const exists = await getAgentStatus(agentId);
      res.json({ configured: exists, agentId });
    } catch (error: any) {
      res.json({ configured: false, agentId: null, error: error.message });
    }
  });

  app.post("/api/goals/agent/sync", async (req, res) => {
    try {
      const { setupAgentCallbackUrl, fetchAndCacheVoiceId } = await import("../elevenlabs");
      const existingAgentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (!existingAgentId) {
        return res.status(400).json({ error: "ELEVENLABS_AGENT_ID not set — configure in Settings → Connections" });
      }
      await fetchAndCacheVoiceId(existingAgentId);
      await setupAgentCallbackUrl(existingAgentId);
      res.json({ agentId: existingAgentId, synced: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/goals/agent/signed-url", async (_req, res) => {
    try {
      const { getSignedUrl } = await import("../elevenlabs");
      const agentId = getSecretSync("ELEVENLABS_AGENT_ID");
      if (!agentId) {
        return res.status(400).json({ error: "Agent not configured — set ELEVENLABS_AGENT_ID in Settings → Connections" });
      }
      const signedUrl = await getSignedUrl(agentId);
      res.json({ signedUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/daily-artifacts/attention", async (_req, res) => {
    try {
      const { getArtifacts } = await import("../period-artifact-storage");
      const today = getDateInTimezone();
      const daily = await getArtifacts(today, "daily");
      const dailyUnviewed = daily ? (!!daily.briefPageId && !daily.briefViewedAt) : false;

      const monday = getMondayOfCurrentWeek();
      const weekly = await getArtifacts(monday, "weekly");
      const weeklyUnviewed = weekly ? (
        (!!weekly.weeklyReflectionPageId && !weekly.weeklyReflectionViewedAt) ||
        (!!weekly.weeklyPlanPageId && !weekly.weeklyPlanViewedAt)
      ) : false;

      const firstOfMonth = getFirstOfCurrentMonth();
      const monthly = await getArtifacts(firstOfMonth, "monthly");
      const monthlyUnviewed = monthly ? (
        (!!monthly.monthlyPlanPageId && !monthly.monthlyPlanViewedAt) ||
        (!!monthly.monthlyReflectionPageId && !monthly.monthlyReflectionViewedAt)
      ) : false;

      res.json({ hasUnviewed: dailyUnviewed || weeklyUnviewed || monthlyUnviewed, dailyUnviewed, weeklyUnviewed, monthlyUnviewed });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/daily-artifacts", async (req, res) => {
    try {
      const { getArtifacts } = await import("../period-artifact-storage");
      const date = (req.query.date as string) || getDateInTimezone();
      const artifacts = await getArtifacts(date, "daily");
      res.json({
        briefPageId: artifacts?.briefPageId || null,
        reviewPageId: artifacts?.reviewPageId || null,
        briefViewedAt: artifacts?.briefViewedAt || null,
        reviewViewedAt: artifacts?.reviewViewedAt || null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/close-out-context", async (req, res) => {
    try {
      const date = (req.query.date as string) || getDateInTimezone();

      const goalPriorities = await goalsService.listPrioritiesForPeriod("today", date);
      const priorities = goalPriorities.map(p => ({
        title: p.title,
        status: p.urgency || "pending",
      }));

      let calendarEvents: Array<{ summary: string; start: string; allDay: boolean }> = [];
      try {
        const { listAllEvents } = await import("../google-calendar");
        const { getTimezone } = await import("../timezone");
        const tz = getTimezone();
        const now = new Date();
        const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
        const tzStr = now.toLocaleString("en-US", { timeZone: tz });
        const diffMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
        const sign = diffMs >= 0 ? "+" : "-";
        const absMins = Math.abs(Math.round(diffMs / 60000));
        const h = String(Math.floor(absMins / 60)).padStart(2, "0");
        const m = String(absMins % 60).padStart(2, "0");
        const tzOffset = `${sign}${h}:${m}`;

        const { events } = await listAllEvents({
          timeMin: `${date}T00:00:00${tzOffset}`,
          timeMax: `${date}T23:59:59${tzOffset}`,
          maxResults: 20,
        });
        calendarEvents = events.map(e => ({
          summary: e.summary || "(no title)",
          start: e.start.dateTime || e.start.date || "",
          allDay: !e.start.dateTime,
        }));
      } catch {
        // Calendar unavailable — degrade gracefully
      }

      let sessionSummaries: Array<{ title: string; type: string }> = [];
      try {
        const { chatFileStorage } = await import("../chat-file-storage");
        const all = await chatFileStorage.getAllSessions();
        const dayStart = new Date(`${date}T00:00:00`);
        const dayEnd = new Date(`${date}T23:59:59`);
        sessionSummaries = all
          .filter(s => {
            const created = new Date(s.createdAt);
            return created >= dayStart && created <= dayEnd && s.title !== "New Chat";
          })
          .map(s => ({ title: s.title, type: s.sessionType || "user" }))
          .slice(0, 20);
      } catch {
        // Sessions unavailable — degrade gracefully
      }

      res.json({ date, priorities, calendarEvents, sessionSummaries });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/weekly-artifacts", async (_req, res) => {
    try {
      const { getArtifacts } = await import("../period-artifact-storage");
      const monday = getMondayOfCurrentWeek();
      const artifacts = await getArtifacts(monday, "weekly");
      res.json({
        weeklyReflectionPageId: artifacts?.weeklyReflectionPageId || null,
        weeklyPlanPageId: artifacts?.weeklyPlanPageId || null,
        mondayDate: monday,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/monthly-artifacts", async (_req, res) => {
    try {
      const { getArtifacts } = await import("../period-artifact-storage");
      const firstOfMonth = getFirstOfCurrentMonth();
      const artifacts = await getArtifacts(firstOfMonth, "monthly");
      res.json({
        monthlyPlanPageId: artifacts?.monthlyPlanPageId || null,
        monthlyReflectionPageId: artifacts?.monthlyReflectionPageId || null,
        firstOfMonth,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/today", async (_req, res) => {
    try {
      const today = getDateInTimezone();
      const priorities = await goalsService.listPrioritiesForPeriod("today", today);
      res.json({ date: today, sessionType: "daily", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/week", async (_req, res) => {
    try {
      const monday = getMondayOfCurrentWeek();
      const priorities = await goalsService.listPrioritiesForPeriod("this_week", monday);
      res.json({ date: monday, sessionType: "weekly", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/week-next", async (_req, res) => {
    try {
      const monday = getMondayOfNextWeek();
      const priorities = await goalsService.listPrioritiesForPeriod("this_week", monday);
      res.json({ date: monday, sessionType: "weekly", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/tomorrow", async (_req, res) => {
    try {
      const tomorrow = getTomorrowDate();
      const priorities = await goalsService.listPrioritiesForPeriod("today", tomorrow);
      res.json({ date: tomorrow, sessionType: "daily", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/month", async (_req, res) => {
    try {
      const firstOfMonth = getFirstOfCurrentMonth();
      const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfMonth);
      res.json({ date: firstOfMonth, sessionType: "monthly", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals/month-next", async (_req, res) => {
    try {
      const firstOfNextMonth = getFirstOfNextMonth();
      const priorities = await goalsService.listPrioritiesForPeriod("this_month", firstOfNextMonth);
      res.json({ date: firstOfNextMonth, sessionType: "monthly", priorities });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/goals", async (req, res) => {
    try {
      const horizon = req.query.horizon as string | undefined;
      const goals = await goalsService.listAll(horizon ? { horizon: horizon as any } : undefined);
      res.json({ goals });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
