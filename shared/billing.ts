export const BILLING_PACKAGE_KEYS = ["max", "max_plus", "factory_plus", "custom"] as const;
export type BillingPackageKey = (typeof BILLING_PACKAGE_KEYS)[number];

export const BILLING_PRICE_KEYS = [
  "max",
  "max_plus",
  "factory_plus",
  "extra_principal",
  "extra_agent",
  "extra_participant",
  "token_overage",
  "custom",
] as const;
export type BillingPriceKey = (typeof BILLING_PRICE_KEYS)[number];

export const BILLING_COLLECTION_STATUSES = [
  "pending_setup",
  "active",
  "past_due",
  "canceled",
  "unpaid",
] as const;
export type BillingCollectionStatus = (typeof BILLING_COLLECTION_STATUSES)[number];

export const BILLING_PAYMENT_METHOD_KINDS = ["card", "us_bank_account", "none"] as const;
export type BillingPaymentMethodKind = (typeof BILLING_PAYMENT_METHOD_KINDS)[number];

export const BILLING_METER_EVENT_NAME = "mantra_token_usage";

export const LADDER_INCLUDE_TOKENS: Record<Exclude<BillingPackageKey, "custom">, number> = {
  max: 50_000_000,
  max_plus: 150_000_000,
  factory_plus: 1_000_000_000,
};

export const PACKAGE_LICENSED_PRICE: Record<BillingPackageKey, BillingPriceKey> = {
  max: "max",
  max_plus: "max_plus",
  factory_plus: "factory_plus",
  custom: "custom",
};

export function isBillingPackageKey(value: string): value is BillingPackageKey {
  return (BILLING_PACKAGE_KEYS as readonly string[]).includes(value);
}

export function isBillingPriceKey(value: string): value is BillingPriceKey {
  return (BILLING_PRICE_KEYS as readonly string[]).includes(value);
}

export interface BillingPriceMapRow {
  key: BillingPriceKey;
  label: string;
  stripePriceId: string | null;
  stripeProductId: string | null;
  amountCents: number | null;
  currency: string;
  mapped: boolean;
  updatedAt: string | null;
}

export interface AccountBillingSummary {
  packageKey: BillingPackageKey;
  collectionStatus: BillingCollectionStatus;
  paymentMethodKind: BillingPaymentMethodKind;
  includeTokens: number;
  cancelAt: string | null;
}

export interface AccountMeterEventInput {
  accountId: string;
  apiCallId: number;
  tokenDelta: number;
  occurredAt: Date;
}
