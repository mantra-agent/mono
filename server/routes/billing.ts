import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import {
  StripeCollectorError,
  requireStripeWebhookSecret,
  verifyStripeSignature,
  type StripeEvent,
} from "../integrations/stripe/client";
import {
  attachAccountBilling,
  processStripeEvent,
  receiveAccountMeterEvent,
  recordCancelNotice,
} from "../billing-service";
import { createLogger } from "../log";

const log = createLogger("billing-routes");

const attachSchema = z.object({
  packageKey: z.enum(["max", "max_plus", "factory_plus", "custom"]),
  includeTokens: z.number().int().min(0).optional(),
}).strict();

const receiveSchema = z.object({
  accountId: z.string().min(1),
  apiCallId: z.number().int().positive(),
  tokenDelta: z.number().int().positive(),
  occurredAt: z.string().min(1).optional(),
}).strict();

function sendCollectorError(res: Response, error: unknown): void {
  if (error instanceof StripeCollectorError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  log.error("billing route failed", error instanceof Error ? error : new Error(String(error)));
  res.status(500).json({ error: "Billing request failed", code: "billing_internal" });
}

export function registerBillingRoutes(app: Express): void {
  app.post(
    "/api/admin/accounts/:id/billing/attach",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const parsed = attachSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid attach payload", code: "billing_attach_invalid" });
          return;
        }
        const result = await attachAccountBilling({
          accountId: String(req.params.id),
          packageKey: parsed.data.packageKey,
          includeTokens: parsed.data.includeTokens,
        });
        res.json(result);
      } catch (error) {
        sendCollectorError(res, error);
      }
    },
  );

  app.post(
    "/api/admin/accounts/:id/billing/cancel-notice",
    requireAuth,
    requirePermission("users:write"),
    async (req: Request, res: Response) => {
      try {
        const billing = await recordCancelNotice(String(req.params.id));
        res.json({ billing });
      } catch (error) {
        sendCollectorError(res, error);
      }
    },
  );

  app.post(
    "/api/internal/billing/meter-events",
    requireAuth,
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const parsed = receiveSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid meter event", code: "billing_meter_input_invalid" });
          return;
        }
        const result = await receiveAccountMeterEvent({
          accountId: parsed.data.accountId,
          apiCallId: parsed.data.apiCallId,
          tokenDelta: parsed.data.tokenDelta,
          occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(),
        });
        res.json(result);
      } catch (error) {
        sendCollectorError(res, error);
      }
    },
  );

  app.post("/api/webhooks/stripe", async (req: Request, res: Response) => {
    try {
      const secret = await requireStripeWebhookSecret();
      const rawBody = Buffer.isBuffer((req as { rawBody?: Buffer }).rawBody)
        ? (req as { rawBody?: Buffer }).rawBody!.toString("utf8")
        : typeof (req as { rawBody?: unknown }).rawBody === "string"
          ? String((req as { rawBody?: unknown }).rawBody)
          : "";
      if (!rawBody || !verifyStripeSignature(rawBody, req.get("stripe-signature") ?? undefined, secret)) {
        res.status(400).json({ error: "Invalid Stripe signature" });
        return;
      }
      const event = JSON.parse(rawBody) as StripeEvent;
      if (!event?.id || !event.type) {
        res.status(400).json({ error: "Invalid Stripe event" });
        return;
      }
      const outcome = await processStripeEvent(event);
      res.json({ received: true, outcome });
    } catch (error) {
      if (error instanceof StripeCollectorError && error.code === "billing_price_not_allowed") {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      sendCollectorError(res, error);
    }
  });
}
