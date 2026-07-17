import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { sendNotification } from "../notifications";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";

const log = createLogger("WaitlistRoutes");
const MAX_ATTRIBUTION_LENGTH = 240;
const MAX_SUBMISSIONS_PER_HOUR = 8;
const submissionWindows = new Map<string, number[]>();

const ROLE_OPTIONS = ["founder", "executive", "investor", "coach", "creator", "other"] as const;
const NEED_OPTIONS = ["priorities", "work", "relationships", "decisions", "health", "money", "connection"] as const;
const READINESS_OPTIONS = ["ready", "possible", "lower_cost", "curious"] as const;
const STATUS_OPTIONS = ["waiting", "reviewing", "invited", "deferred", "declined"] as const;

const attributionSchema = z.object({
  source: z.string().trim().max(MAX_ATTRIBUTION_LENGTH).optional(),
  utmSource: z.string().trim().max(MAX_ATTRIBUTION_LENGTH).optional(),
  utmMedium: z.string().trim().max(MAX_ATTRIBUTION_LENGTH).optional(),
  utmCampaign: z.string().trim().max(MAX_ATTRIBUTION_LENGTH).optional(),
  utmContent: z.string().trim().max(MAX_ATTRIBUTION_LENGTH).optional(),
  referrer: z.string().trim().max(1000).optional(),
  landingPath: z.string().trim().max(1000).optional(),
}).strict();

const waitlistSubmissionSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(ROLE_OPTIONS),
  needs: z.array(z.enum(NEED_OPTIONS)).min(1).max(3),
  readiness: z.enum(READINESS_OPTIONS),
  attribution: attributionSchema.optional(),
  consent: z.literal(true),
  website: z.string().max(0).optional(),
}).strict();

interface WaitlistRow {
  id: string;
  email: string;
  position: number;
  status: string;
  role: string;
  needs: string[];
  readiness: string;
  source: string | null;
  attribution: Record<string, unknown>;
  confirmation_email_status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requestFingerprint(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]) || req.ip || "unknown";
  return crypto.createHash("sha256").update(`${ip.trim()}:waitlist`).digest("hex");
}

function rateLimitExceeded(fingerprint: string): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = (submissionWindows.get(fingerprint) || []).filter((time) => time > cutoff);
  if (recent.length >= MAX_SUBMISSIONS_PER_HOUR) {
    submissionWindows.set(fingerprint, recent);
    return true;
  }
  recent.push(now);
  submissionWindows.set(fingerprint, recent);
  return false;
}

function publicApplication(row: WaitlistRow, result: "created" | "existing") {
  return {
    result,
    application: {
      id: row.id,
      email: row.email,
      position: row.position,
      status: row.status,
    },
  };
}

function adminApplication(row: WaitlistRow) {
  return {
    id: row.id,
    email: row.email,
    position: row.position,
    status: row.status,
    role: row.role,
    needs: row.needs,
    readiness: row.readiness,
    source: row.source,
    attribution: row.attribution,
    confirmationEmailStatus: row.confirmation_email_status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function confirmationCopy(position: number) {
  const body = [
    `You’re #${position} on the Mantra waitlist.`,
    "",
    "We’re opening Mantra in small groups, prioritizing the people for whom it can create the most value today.",
    "",
    "Early Mantra memberships include a personalized setup fee and cost $500/month.",
    "",
    "We’ll email you when there’s a place for you.",
  ].join("\n");
  const html = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#f5f5f5;padding:40px 24px"><div style="max-width:560px;margin:0 auto"><p style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a3a3a3">Mantra</p><h1 style="font-size:36px;line-height:1.1;margin:28px 0 18px">You’re #${position}.</h1><p style="font-size:17px;line-height:1.6;color:#d4d4d4">You’re on the Mantra waitlist. We’re opening in small groups, prioritizing the people for whom Mantra can create the most value today.</p><p style="font-size:15px;line-height:1.6;color:#a3a3a3;margin-top:24px">Early memberships include a personalized setup fee and cost $500/month. We’ll email you when there’s a place for you.</p></div></div>`;
  return { body, html };
}

async function sendConfirmation(row: WaitlistRow): Promise<void> {
  const copy = confirmationCopy(row.position);
  const result = await sendNotification({
    channel: "email",
    to: row.email,
    from: "hello@trymantra.ai",
    subject: `You’re #${row.position} on the Mantra waitlist`,
    body: copy.body,
    html: copy.html,
    metadata: { source: "public-waitlist", applicationId: row.id, position: row.position },
  });
  await db.execute(sql`
    UPDATE waitlist_applications
    SET confirmation_email_status = ${result.ok ? "accepted" : "failed"},
        confirmation_email_provider_id = ${result.providerMessageId || null},
        confirmation_email_error = ${result.error || null},
        confirmation_email_sent_at = ${result.ok ? new Date() : null},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid
  `);
  if (!result.ok) {
    log.warn("Waitlist application saved but confirmation email was not accepted", {
      applicationId: row.id,
      position: row.position,
      status: result.status,
    });
  }
}

export function registerWaitlistRoutes(app: Express): void {
  app.post("/api/public/waitlist", async (req: Request, res: Response) => {
    const fingerprint = requestFingerprint(req);
    if (rateLimitExceeded(fingerprint)) {
      return res.status(429).json({ error: "Too many submissions. Please try again later." });
    }

    const parsed = waitlistSubmissionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Please complete each waitlist question." });
    }

    const email = normalizedEmail(parsed.data.email);
    const attribution = parsed.data.attribution || {};
    try {
      const inserted = await db.execute<WaitlistRow>(sql`
        INSERT INTO waitlist_applications (email, role, needs, readiness, source, attribution)
        VALUES (
          ${email},
          ${parsed.data.role},
          ARRAY[${sql.join(parsed.data.needs.map((need) => sql`${need}`), sql`, `)}]::text[],
          ${parsed.data.readiness},
          ${attribution.source || "direct"},
          ${JSON.stringify(attribution)}::jsonb
        )
        ON CONFLICT (email) DO NOTHING
        RETURNING *
      `);

      if (inserted.rows[0]) {
        const row = inserted.rows[0];
        log.info("Waitlist application created", { applicationId: row.id, position: row.position, source: row.source });
        void sendConfirmation(row).catch((error) => {
          log.error("Waitlist confirmation processing failed", {
            applicationId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return res.status(201).json(publicApplication(row, "created"));
      }

      const existing = await db.execute<WaitlistRow>(sql`SELECT * FROM waitlist_applications WHERE email = ${email} LIMIT 1`);
      return res.json(publicApplication(existing.rows[0], "existing"));
    } catch (error) {
      log.error("Waitlist submission failed", error);
      return res.status(500).json({ error: "We couldn’t save your place. Please try again." });
    }
  });

  app.get("/api/admin/waitlist", requireAuth, requirePermission("users:read"), async (_req: Request, res: Response) => {
    try {
      const result = await db.execute<WaitlistRow>(sql`SELECT * FROM waitlist_applications ORDER BY position ASC LIMIT 1000`);
      return res.json({ applications: result.rows.map(adminApplication) });
    } catch (error) {
      log.error("Waitlist admin list failed", error);
      return res.status(500).json({ error: "Failed to load waitlist" });
    }
  });

  app.patch("/api/admin/waitlist/:id", requireAuth, requirePermission("users:write"), async (req: Request, res: Response) => {
    const status = z.enum(STATUS_OPTIONS).safeParse(req.body?.status);
    if (!status.success) return res.status(400).json({ error: "Invalid waitlist status" });
    try {
      const result = await db.execute<WaitlistRow>(sql`
        UPDATE waitlist_applications
        SET status = ${status.data}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${req.params.id}::uuid
        RETURNING *
      `);
      if (!result.rows[0]) return res.status(404).json({ error: "Waitlist application not found" });
      return res.json({ application: adminApplication(result.rows[0]) });
    } catch (error) {
      log.error("Waitlist status update failed", error);
      return res.status(500).json({ error: "Failed to update waitlist application" });
    }
  });
}
