import type { Express, Request, Response } from "express";
import { requireAuth } from "./auth";
import { requirePermission } from "./permissions";
import {
  ensureMetricsDefinitionsSchema,
  kpiStorage,
  metricsStorage,
} from "./metrics-storage";
import {
  kpiCreateSchema,
  kpiUpdateSchema,
  metricCreateSchema,
  metricSampleCreateSchema,
  metricUpdateSchema,
} from "@shared/models/metrics";
import { seedDefaultMetricsAndKpis } from "./metrics-seed";
import { getCurrentPrincipal } from "./principal-context";
import { createLogger } from "./log";

const log = createLogger("MetricsRoutes");

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Request failed";
}

function respondError(res: Response, operation: string, error: unknown): void {
  const status = statusOf(error);
  log.error(`${operation} failed`, {
    status,
    code: (error as { code?: unknown })?.code,
    message: messageOf(error),
  });
  res.status(status).json({ error: messageOf(error) });
}

let bootstrapped: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await ensureMetricsDefinitionsSchema();
    })().catch((err) => {
      bootstrapped = null;
      throw err;
    });
  }
  await bootstrapped;
}

// Seeding the standing-objective KPIs requires an authenticated principal, so
// it cannot run at boot. Run it lazily on the first authenticated read for an
// account. The seed is itself idempotent (skips existing objective keys); the
// in-memory guard just avoids re-running two list queries on every request.
const seededScopes = new Set<string>();

async function ensureSeeded(): Promise<void> {
  const principal = getCurrentPrincipal();
  const accountId = principal?.accountId;
  const activeVaultId = principal?.activeVaultId;
  const seedScope = accountId && activeVaultId
    ? `${accountId}:${activeVaultId}`
    : null;
  if (!seedScope || seededScopes.has(seedScope)) return;
  try {
    await seedDefaultMetricsAndKpis();
    seededScopes.add(seedScope);
  } catch (error) {
    log.warn("lazy metrics/kpi seed failed; will retry next read", {
      accountId,
      message: messageOf(error),
    });
  }
}

export function registerMetricsRoutes(app: Express): void {
  // ── Metrics ──────────────────────────────────────────────────────
  app.get(
    "/api/business/metrics",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        await ensureSeeded();
        const query = typeof req.query.query === "string" ? req.query.query : undefined;
        const list = await metricsStorage.list(query);
        res.json({ metrics: list });
      } catch (error) {
        respondError(res, "list metrics", error);
      }
    },
  );

  app.get(
    ["/api/business/metrics/range-sample", "/api/business/metrics/usage-sample"],
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const start = typeof req.query.start === "string" ? new Date(req.query.start) : null;
        const end = typeof req.query.end === "string" ? new Date(req.query.end) : null;
        if (!start || !end) {
          res.status(400).json({ error: "start and end are required ISO timestamps" });
          return;
        }
        res.json(await metricsStorage.sampleRange(start, end));
      } catch (error) {
        respondError(res, "sample usage metrics", error);
      }
    },
  );

  app.get(
    "/api/business/metrics/:id",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const metric = await metricsStorage.get(req.params.id);
        res.json(metric);
      } catch (error) {
        respondError(res, "get metric", error);
      }
    },
  );

  app.post(
    "/api/business/metrics",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const metric = await metricsStorage.create(metricCreateSchema.parse(req.body ?? {}));
        log.info("metric created", { metricId: metric.id });
        res.status(201).json(metric);
      } catch (error) {
        respondError(res, "create metric", error);
      }
    },
  );

  app.patch(
    "/api/business/metrics/:id",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const metric = await metricsStorage.update(
          req.params.id,
          metricUpdateSchema.parse(req.body ?? {}),
        );
        res.json(metric);
      } catch (error) {
        respondError(res, "update metric", error);
      }
    },
  );

  app.delete(
    "/api/business/metrics/:id",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const metric = await metricsStorage.delete(req.params.id);
        res.json(metric);
      } catch (error) {
        respondError(res, "delete metric", error);
      }
    },
  );

  app.get(
    "/api/business/metrics/:id/samples",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const samples = await metricsStorage.listSamples(req.params.id, limit);
        res.json({ samples });
      } catch (error) {
        respondError(res, "list metric samples", error);
      }
    },
  );

  app.post(
    "/api/business/metrics/:id/samples",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const body = metricSampleCreateSchema.parse({
          ...(req.body ?? {}),
          metricId: req.params.id,
        });
        const sample = await metricsStorage.recordSample(body);
        res.status(201).json(sample);
      } catch (error) {
        respondError(res, "record metric sample", error);
      }
    },
  );

  // ── KPIs ─────────────────────────────────────────────────────────
  app.get(
    "/api/business/kpis",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        await ensureSeeded();
        const query = typeof req.query.query === "string" ? req.query.query : undefined;
        const list = await kpiStorage.list(query);
        res.json({ kpis: list });
      } catch (error) {
        respondError(res, "list kpis", error);
      }
    },
  );

  app.get(
    "/api/business/kpis/standing-scores",
    requireAuth,
    requirePermission("system:read"),
    async (_req: Request, res: Response) => {
      try {
        await ensureReady();
        await ensureSeeded();
        const scores = await kpiStorage.standingObjectiveScores();
        res.json({ scores });
      } catch (error) {
        respondError(res, "standing kpi scores", error);
      }
    },
  );

  app.get(
    "/api/business/kpis/:id",
    requireAuth,
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const kpi = await kpiStorage.get(req.params.id);
        res.json(kpi);
      } catch (error) {
        respondError(res, "get kpi", error);
      }
    },
  );

  app.post(
    "/api/business/kpis",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const kpi = await kpiStorage.create(kpiCreateSchema.parse(req.body ?? {}));
        log.info("kpi created", { kpiId: kpi.id });
        res.status(201).json(kpi);
      } catch (error) {
        respondError(res, "create kpi", error);
      }
    },
  );

  app.patch(
    "/api/business/kpis/:id",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const kpi = await kpiStorage.update(req.params.id, kpiUpdateSchema.parse(req.body ?? {}));
        res.json(kpi);
      } catch (error) {
        respondError(res, "update kpi", error);
      }
    },
  );

  app.delete(
    "/api/business/kpis/:id",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await ensureReady();
        const kpi = await kpiStorage.delete(req.params.id);
        res.json(kpi);
      } catch (error) {
        respondError(res, "delete kpi", error);
      }
    },
  );

  app.post(
    "/api/business/metrics-kpis/seed",
    requireAuth,
    requirePermission("system:write"),
    async (_req: Request, res: Response) => {
      try {
        await ensureReady();
        const result = await seedDefaultMetricsAndKpis();
        res.json(result);
      } catch (error) {
        respondError(res, "seed metrics/kpis", error);
      }
    },
  );
}
