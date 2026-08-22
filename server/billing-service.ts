import { and, eq, inArray, sql } from "drizzle-orm";
import {
  BILLING_METER_EVENT_NAME,
  type AccountBillingSummary,
  type AccountMeterEventInput,
  type BillingCollectionStatus,
  type BillingPackageKey,
  type BillingPaymentMethodKind,
  type BillingPriceMapRow,
  isBillingPackageKey,
} from "@shared/billing";
import { accountBilling, accounts, billingMeterDeliveries, billingPrices, billingWebhookEvents, businessPricing, businesses, users } from "@shared/schema";
import { normalizePricingExtras, normalizePricingPackages, projectPackage, type PricingPackageView } from "@shared/models/business-pricing";
import { registerOverageMeterEmitter, type MeterEmitResult, type OverageMeterEvent } from "./billing-meter-port";
import { db } from "./db";
import {
  StripeCollectorError,
  stripeRequest,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripeEvent,
  type StripeSubscription,
} from "./integrations/stripe/client";
import { createLogger } from "./log";
import { getRuntimePublicBaseUrl } from "./runtime-identity";
import { createSerialQueue } from "./utils/serial-async-delivery";

const log = createLogger("billing");
const deliveryQueue = createSerialQueue({ label: "billing-meter-deliveries" });
const ALLOWED_WEBHOOK_TYPES = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

type AccountBillingRow = typeof accountBilling.$inferSelect;

function yearFrom(start: Date): Date {
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end;
}

function addDays(start: Date, days: number): Date {
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

function laterDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function asSummary(row: AccountBillingRow): AccountBillingSummary {
  return {
    packageKey: row.packageKey as BillingPackageKey,
    collectionStatus: row.collectionStatus as BillingCollectionStatus,
    paymentMethodKind: row.paymentMethodKind as BillingPaymentMethodKind,
    includeTokens: row.includeTokens,
    cancelAt: row.cancelAt ? row.cancelAt.toISOString() : null,
  };
}

export async function listAccountBillingSummaries(
  accountIds: string[],
): Promise<Map<string, AccountBillingSummary>> {
  const summaries = new Map<string, AccountBillingSummary>();
  if (accountIds.length === 0) return summaries;
  const rows = await db.select().from(accountBilling).where(inArray(accountBilling.accountId, accountIds));
  for (const row of rows) summaries.set(row.accountId, asSummary(row));
  return summaries;
}

interface CurrentPricingRevision {
  businessId: string;
  revisionId: string;
  packages: PricingPackageView[];
  extras: ReturnType<typeof normalizePricingExtras>;
}

async function loadCurrentPricingRevision(): Promise<CurrentPricingRevision> {
  const [row] = await db.select({ pricing: businessPricing, businessId: businesses.id })
    .from(businessPricing)
    .innerJoin(businesses, eq(businesses.id, businessPricing.businessId))
    .where(eq(businesses.isPlatformInstrument, true))
    .orderBy(sql`${businessPricing.updatedAt} DESC`)
    .limit(1);
  if (!row) throw new StripeCollectorError("Platform Business Pricing is missing", "billing_pricing_missing", 503);
  const revisionId = `pricing_rev_${row.pricing.id}_${row.pricing.updatedAt.getTime()}`;
  await db.execute(sql`
    INSERT INTO business_pricing_revisions (id, business_id, pricing_id, snapshot, created_at)
    VALUES (${revisionId}, ${row.businessId}, ${row.pricing.id}, ${JSON.stringify({ packages: row.pricing.packages, extras: row.pricing.extras })}::jsonb, ${row.pricing.updatedAt})
    ON CONFLICT (id) DO NOTHING
  `);
  return {
    businessId: row.businessId,
    revisionId,
    packages: normalizePricingPackages(row.pricing.packages).map(projectPackage),
    extras: normalizePricingExtras(row.pricing.extras),
  };
}

function projectEntries(pricing: CurrentPricingRevision): Omit<BillingPriceMapRow, "stripePriceId" | "stripeProductId" | "mapped" | "updatedAt">[] {
  const rows: Omit<BillingPriceMapRow, "stripePriceId" | "stripeProductId" | "mapped" | "updatedAt">[] = [];
  for (const pkg of pricing.packages) {
    rows.push({ businessId: pricing.businessId, pricingRevisionId: pricing.revisionId, key: pkg.key, label: pkg.name, amountCents: Math.round(pkg.listMonthly * 100), currency: "usd", cadence: "monthly", includedUsage: `${pkg.includedTokensMillions}M tokens` });
  }
  const extras = pricing.packages.find((pkg) => pkg.key === "factory_plus") ?? pricing.packages[0];
  if (extras?.extraPrincipalMonthly != null) rows.push({ businessId: pricing.businessId, pricingRevisionId: pricing.revisionId, key: "extra_principal", label: "Extra Principal", amountCents: Math.round(extras.extraPrincipalMonthly * 100), currency: "usd", cadence: "monthly", includedUsage: null });
  if (extras?.extraAgentMonthly != null) rows.push({ businessId: pricing.businessId, pricingRevisionId: pricing.revisionId, key: "extra_agent", label: "Extra Agent", amountCents: Math.round(extras.extraAgentMonthly * 100), currency: "usd", cadence: "monthly", includedUsage: null });
  const participant = pricing.packages.find((pkg) => pkg.extraParticipantMonthly != null)?.extraParticipantMonthly;
  if (participant != null) rows.push({ businessId: pricing.businessId, pricingRevisionId: pricing.revisionId, key: "extra_participant", label: "Extra Participant", amountCents: Math.round(participant * 100), currency: "usd", cadence: "monthly", includedUsage: null });
  rows.push({ businessId: pricing.businessId, pricingRevisionId: pricing.revisionId, key: "token_overage", label: "Token Overage", amountCents: Math.round(pricing.extras.extraUsagePerMillion * 100), currency: "usd", cadence: "metered", includedUsage: "1M tokens" });
  return rows;
}

export async function listBillingPriceMap(): Promise<BillingPriceMapRow[]> {
  const pricing = await loadCurrentPricingRevision();
  const entries = projectEntries(pricing);
  const bindings = await db.select().from(billingPrices).where(eq(billingPrices.pricingRevisionId, pricing.revisionId));
  const byKey = new Map(bindings.map((row) => [row.entryKey, row]));
  return entries.map((entry) => {
    const binding = byKey.get(entry.key);
    return { ...entry, stripePriceId: binding?.stripePriceId ?? null, stripeProductId: binding?.stripeProductId ?? null, mapped: Boolean(binding?.stripePriceId), updatedAt: binding?.updatedAt.toISOString() ?? null };
  });
}

export async function upsertBillingPriceMapEntry(input: { pricingRevisionId: string; key: string; stripePriceId: string | null; stripeProductId: string | null }): Promise<BillingPriceMapRow> {
  const current = await listBillingPriceMap();
  const entry = current.find((row) => row.pricingRevisionId === input.pricingRevisionId && row.key === input.key);
  if (!entry) throw new StripeCollectorError("Pricing entry is not current", "billing_pricing_entry_stale", 409);
  const stripePriceId = input.stripePriceId?.trim() || null;
  const stripeProductId = input.stripeProductId?.trim() || null;
  if (stripePriceId && !/^price_[A-Za-z0-9]+$/.test(stripePriceId)) throw new StripeCollectorError("stripePriceId must look like price_…", "billing_price_id_invalid");
  if (stripeProductId && !/^prod_[A-Za-z0-9]+$/.test(stripeProductId)) throw new StripeCollectorError("stripeProductId must look like prod_…", "billing_product_id_invalid");
  await db.insert(billingPrices).values({ pricingRevisionId: input.pricingRevisionId, entryKey: input.key, stripePriceId, stripeProductId, updatedAt: new Date() }).onConflictDoUpdate({ target: [billingPrices.pricingRevisionId, billingPrices.entryKey], set: { stripePriceId, stripeProductId, updatedAt: new Date() } });
  const updated = (await listBillingPriceMap()).find((row) => row.key === input.key);
  if (!updated) throw new StripeCollectorError("Price binding missing after upsert", "billing_price_map_missing", 500);
  log.info("billing price binding upserted", { pricingRevisionId: input.pricingRevisionId, key: input.key });
  return updated;
}

function assertKnownPriceIds(priceIds: Array<string | undefined>, row: AccountBillingRow): void {
  const allowed = new Set([row.licensedStripePriceId, row.overageStripePriceId].filter(Boolean));
  for (const priceId of priceIds) if (priceId && !allowed.has(priceId)) throw new StripeCollectorError("Subscription item differs from the accepted Account billing snapshot", "billing_price_not_allowed");
}

async function ownerEmailForAccount(accountId: string): Promise<string | null> {
  const [account] = await db.select({ ownerUserId: accounts.ownerUserId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account?.ownerUserId) return null;
  const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, account.ownerUserId)).limit(1);
  return owner?.email ?? null;
}

async function ensureCustomer(accountId: string, existingCustomerId: string | null): Promise<string> {
  if (existingCustomerId) return existingCustomerId;
  const email = await ownerEmailForAccount(accountId);
  const customer = await stripeRequest<StripeCustomer>("POST", "/customers", {
    email: email ?? undefined,
    "metadata[account_id]": accountId,
  }, `acct-customer:${accountId}`);
  if (!customer.id.startsWith("cus_")) {
    throw new StripeCollectorError("Stripe returned a non-customer id", "billing_stripe_customer_invalid", 502);
  }
  return customer.id;
}

async function ensurePlatformMeter(): Promise<string> {
  const existing = await stripeRequest<{ data?: Array<{ id: string; event_name?: string }> }>("GET", "/billing/meters?limit=100");
  const found = existing.data?.find((meter) => meter.event_name === BILLING_METER_EVENT_NAME);
  if (found?.id) return found.id;
  const created = await stripeRequest<{ id: string }>("POST", "/billing/meters", {
    display_name: "Mantra token usage",
    event_name: BILLING_METER_EVENT_NAME,
    "default_aggregation[formula]": "sum",
    "customer_mapping[event_payload_key]": "stripe_customer_id",
    "customer_mapping[type]": "by_id",
    "value_settings[event_payload_key]": "value",
  }, "platform-token-meter");
  return created.id;
}

export async function attachAccountBilling(input: {
  accountId: string;
  packageKey: string;
  includeTokens?: number;
}): Promise<{ billing: AccountBillingSummary; checkoutUrl: string }> {
  if (!isBillingPackageKey(input.packageKey)) {
    throw new StripeCollectorError("Unknown package key", "billing_package_unknown");
  }
  const [account] = await db
    .select({ id: accounts.id, includedTokens: accounts.includedTokens })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .limit(1);
  if (!account) throw new StripeCollectorError("Account not found", "billing_account_missing", 404);

  const pricing = await loadCurrentPricingRevision();
  const pkg = pricing.packages.find((candidate) => candidate.key === input.packageKey);
  if (!pkg) throw new StripeCollectorError("Pricing package is missing", "billing_package_missing", 503);
  const includeTokens = Math.round(pkg.includedTokensMillions * 1_000_000);
  const bindings = await db.select().from(billingPrices).where(eq(billingPrices.pricingRevisionId, pricing.revisionId));
  const licensedPriceId = bindings.find((binding) => binding.entryKey === input.packageKey)?.stripePriceId;
  const overagePriceId = bindings.find((binding) => binding.entryKey === "token_overage")?.stripePriceId;
  if (!licensedPriceId || !overagePriceId) {
    throw new StripeCollectorError("Required collector Prices are missing", "billing_price_map_incomplete", 503);
  }

  const [existing] = await db.select().from(accountBilling).where(eq(accountBilling.accountId, input.accountId)).limit(1);
  const customerId = await ensureCustomer(input.accountId, existing?.stripeCustomerId ?? null);
  const meterId = await ensurePlatformMeter();
  const publicUrl = await getRuntimePublicBaseUrl();
  if (!publicUrl) throw new StripeCollectorError("Public base URL is not configured", "billing_public_url_missing", 503);

  const startedAt = existing?.termStartedAt ?? new Date();
  const endsAt = existing?.termEndsAt ?? yearFrom(startedAt);
  const session = await stripeRequest<StripeCheckoutSession>("POST", "/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "us_bank_account",
    "line_items[0][price]": licensedPriceId,
    "line_items[0][quantity]": 1,
    "line_items[1][price]": overagePriceId,
    "metadata[account_id]": input.accountId,
    "subscription_data[metadata][account_id]": input.accountId,
    success_url: `${publicUrl}/system?tab=accounts`,
    cancel_url: `${publicUrl}/system?tab=accounts`,
  }, `acct-checkout:${input.accountId}:${input.packageKey}`);
  if (!session.url) throw new StripeCollectorError("Checkout Session has no URL", "billing_checkout_url_missing", 502);

  const values = {
    accountId: input.accountId,
    packageKey: input.packageKey,
    pricingRevisionId: pricing.revisionId,
    licensedStripePriceId: licensedPriceId,
    overageStripePriceId: overagePriceId,
    includeTokens,
    stripeCustomerId: customerId,
    stripeMeterId: meterId,
    termStartedAt: startedAt,
    termEndsAt: endsAt,
    collectionStatus: existing?.collectionStatus ?? "pending_setup",
    paymentMethodKind: existing?.paymentMethodKind ?? "none",
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await db.update(accountBilling).set(values).where(eq(accountBilling.id, existing.id)).returning()
    : await db.insert(accountBilling).values(values).returning();

  await db.update(accounts).set({
    includedTokens: includeTokens,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(eq(accounts.id, input.accountId));

  log.info("billing attached", { accountBillingId: row.id, packageKey: row.packageKey });
  return { billing: asSummary(row), checkoutUrl: session.url };
}

export async function recordCancelNotice(accountId: string): Promise<AccountBillingSummary> {
  const [row] = await db.select().from(accountBilling).where(eq(accountBilling.accountId, accountId)).limit(1);
  if (!row) throw new StripeCollectorError("Billing relationship is missing", "billing_row_missing", 404);
  if (!row.stripeSubscriptionId) throw new StripeCollectorError("Subscription is not active", "billing_subscription_missing", 409);
  const noticeAt = new Date();
  const computed = laterDate(addDays(noticeAt, 90), row.termEndsAt ?? addDays(noticeAt, 90));
  await stripeRequest<StripeSubscription>("POST", `/subscriptions/${row.stripeSubscriptionId}`, {
    cancel_at: Math.floor(computed.getTime() / 1000),
  });
  const [updated] = await db.update(accountBilling).set({
    cancelNoticeAt: noticeAt,
    cancelAt: computed,
    updatedAt: new Date(),
  }).where(eq(accountBilling.id, row.id)).returning();
  return asSummary(updated);
}

function mapStripeStatus(status: string | undefined): BillingCollectionStatus | null {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due") return "past_due";
  if (status === "unpaid") return "unpaid";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return null;
}

async function loadRowByCustomerOrAccount(object: Record<string, unknown>): Promise<AccountBillingRow | null> {
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const accountId = typeof metadata.account_id === "string" ? metadata.account_id : null;
  if (accountId) {
    const [row] = await db.select().from(accountBilling).where(eq(accountBilling.accountId, accountId)).limit(1);
    if (row) return row;
  }
  const customer = typeof object.customer === "string" ? object.customer : null;
  if (customer) {
    const [row] = await db.select().from(accountBilling).where(eq(accountBilling.stripeCustomerId, customer)).limit(1);
    if (row) return row;
  }
  const subscription = typeof object.subscription === "string"
    ? object.subscription
    : typeof object.id === "string" && object.id.startsWith("sub_")
      ? object.id
      : null;
  if (subscription) {
    const [row] = await db.select().from(accountBilling).where(eq(accountBilling.stripeSubscriptionId, subscription)).limit(1);
    if (row) return row;
  }
  return null;
}

export async function processStripeEvent(event: StripeEvent): Promise<"ignored" | "replay" | "processed"> {
  if (!ALLOWED_WEBHOOK_TYPES.has(event.type)) return "ignored";
  try {
    await db.insert(billingWebhookEvents).values({ stripeEventId: event.id, eventType: event.type });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "23505") return "replay";
    throw error;
  }

  const object = event.data.object;
  const row = await loadRowByCustomerOrAccount(object);
  if (!row) {
    log.warn("billing webhook had no account_billing row", { eventId: event.id, type: event.type });
    return "processed";
  }

  const priceIds = (
    (object.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data
    ?? (object.lines as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data
    ?? []
  ).map((item) => item.price?.id);
  if (priceIds.some(Boolean)) assertKnownPriceIds(priceIds, row);

  const patch: Partial<AccountBillingRow> = { updatedAt: new Date() };
  if (event.type === "checkout.session.completed") {
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
    if (subscriptionId?.startsWith("sub_")) patch.stripeSubscriptionId = subscriptionId;
    const types = object.payment_method_types;
    if (Array.isArray(types)) {
      if (types.includes("us_bank_account")) patch.paymentMethodKind = "us_bank_account";
      else if (types.includes("card")) patch.paymentMethodKind = "card";
    }
    patch.collectionStatus = "active";
  } else if (event.type === "invoice.paid") {
    patch.collectionStatus = "active";
  } else if (event.type === "invoice.payment_failed") {
    patch.collectionStatus = "past_due";
  } else {
    const mapped = mapStripeStatus(typeof object.status === "string" ? object.status : undefined);
    if (mapped) patch.collectionStatus = mapped;
    if (typeof object.id === "string" && object.id.startsWith("sub_")) patch.stripeSubscriptionId = object.id;
  }

  await db.update(accountBilling).set(patch).where(eq(accountBilling.id, row.id));
  await db.update(billingWebhookEvents).set({
    accountBillingId: row.id,
    stripeObjectId: typeof object.id === "string" ? object.id : null,
  }).where(eq(billingWebhookEvents.stripeEventId, event.id));
  log.info("billing webhook processed", { eventId: event.id, type: event.type, accountBillingId: row.id });
  return "processed";
}

async function queueDelivery(input: {
  accountId: string;
  identifier: string;
  tokenDelta: number;
  occurredAt: Date;
  apiCallId?: number;
}): Promise<{ status: "queued" | "delivered" | "error" | "replay"; code?: string }> {
  const [row] = await db.select().from(accountBilling).where(eq(accountBilling.accountId, input.accountId)).limit(1);
  if (!row || !row.stripeCustomerId || !row.stripeMeterId || (row.collectionStatus !== "active" && row.collectionStatus !== "past_due")) {
    throw new StripeCollectorError("Account has no collectible billing row", "billing_meter_account_unready", 409);
  }

  let deliveryId: string;
  try {
    const [inserted] = await db.insert(billingMeterDeliveries).values({
      apiCallId: input.apiCallId ?? null,
      accountId: input.accountId,
      accountBillingId: row.id,
      tokenDelta: input.tokenDelta,
      occurredAt: input.occurredAt,
      stripeIdentifier: input.identifier,
      status: "queued",
    }).returning({ id: billingMeterDeliveries.id });
    deliveryId = inserted.id;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
    if (code === "23505") return { status: "replay" };
    throw error;
  }

  void deliveryQueue.enqueueAndWait(() => deliverMeterEvent(deliveryId)).catch((error) => {
    log.error("billing meter drain failed", error instanceof Error ? error : new Error(String(error)), { deliveryId });
  });
  return { status: "queued" };
}

export async function receiveAccountMeterEvent(input: AccountMeterEventInput) {
  if (!Number.isInteger(input.apiCallId) || input.apiCallId <= 0) {
    throw new StripeCollectorError("apiCallId is required", "billing_meter_input_invalid");
  }
  if (!Number.isInteger(input.tokenDelta) || input.tokenDelta <= 0) {
    throw new StripeCollectorError("tokenDelta must be a positive integer", "billing_meter_input_invalid");
  }
  return queueDelivery({
    accountId: input.accountId,
    identifier: `api_call:${input.apiCallId}`,
    tokenDelta: input.tokenDelta,
    occurredAt: input.occurredAt,
    apiCallId: input.apiCallId,
  });
}

export async function receiveOverageWatermark(event: OverageMeterEvent): Promise<MeterEmitResult> {
  if (!Number.isInteger(event.quantity) || event.quantity <= 0) {
    return { outcome: "failed", error: "billing_meter_input_invalid" };
  }
  try {
    const result = await queueDelivery({
      accountId: event.accountId,
      identifier: event.idempotencyKey,
      tokenDelta: event.quantity,
      occurredAt: new Date(),
    });
    if (result.status === "error") return { outcome: "failed", error: result.code ?? "billing_meter_deliver_failed" };
    return { outcome: "emitted" };
  } catch (error) {
    if (error instanceof StripeCollectorError && error.code === "billing_meter_account_unready") {
      return { outcome: "unconnected" };
    }
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

registerOverageMeterEmitter(receiveOverageWatermark);

async function deliverMeterEvent(deliveryId: string): Promise<void> {
  const [delivery] = await db.select().from(billingMeterDeliveries)
    .where(and(eq(billingMeterDeliveries.id, deliveryId), eq(billingMeterDeliveries.status, "queued")))
    .limit(1);
  if (!delivery) return;
  const [row] = await db.select().from(accountBilling).where(eq(accountBilling.id, delivery.accountBillingId)).limit(1);
  if (!row?.stripeCustomerId) {
    await markDelivery(delivery.id, "error", "billing_meter_account_unready", delivery.attempts + 1);
    return;
  }
  let attempts = delivery.attempts;
  while (attempts < 5) {
    try {
      await stripeRequest("POST", "/billing/meter_events", {
        event_name: BILLING_METER_EVENT_NAME,
        identifier: delivery.stripeIdentifier,
        timestamp: Math.floor(delivery.occurredAt.getTime() / 1000),
        "payload[stripe_customer_id]": row.stripeCustomerId,
        "payload[value]": delivery.tokenDelta,
      }, delivery.stripeIdentifier);
      await markDelivery(delivery.id, "delivered", null, attempts + 1);
      return;
    } catch (error) {
      attempts += 1;
      const code = error instanceof StripeCollectorError ? error.code : "billing_meter_deliver_failed";
      if (attempts >= 5) {
        await markDelivery(delivery.id, "error", code, attempts);
        log.error("billing meter delivery exhausted", error instanceof Error ? error : new Error(String(error)), {
          deliveryId: delivery.id,
          attempts,
          code,
        });
        return;
      }
      await markDelivery(delivery.id, "queued", code, attempts);
    }
  }
}

async function markDelivery(
  id: string,
  status: "queued" | "delivered" | "error",
  lastErrorCode: string | null,
  attempts: number,
): Promise<void> {
  await db.update(billingMeterDeliveries).set({
    status,
    lastErrorCode,
    attempts,
    updatedAt: new Date(),
  }).where(eq(billingMeterDeliveries.id, id));
}
