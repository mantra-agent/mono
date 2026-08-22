export const BILLING_PACKAGE_KEYS = ["max", "max_plus", "factory_plus"] as const;
export type BillingPackageKey = (typeof BILLING_PACKAGE_KEYS)[number];

export const BILLING_COLLECTION_STATUSES = ["pending_setup", "active", "past_due", "canceled", "unpaid"] as const;
export type BillingCollectionStatus = (typeof BILLING_COLLECTION_STATUSES)[number];

export const BILLING_PAYMENT_METHOD_KINDS = ["card", "us_bank_account", "none"] as const;
export type BillingPaymentMethodKind = (typeof BILLING_PAYMENT_METHOD_KINDS)[number];

export const BILLING_METER_EVENT_NAME = "mantra_token_usage";

export function isBillingPackageKey(value: string): value is BillingPackageKey {
  return (BILLING_PACKAGE_KEYS as readonly string[]).includes(value);
}

export interface BillingPriceMapRow {
  businessId: string;
  pricingRevisionId: string;
  key: string;
  label: string;
  stripePriceId: string | null;
  stripeProductId: string | null;
  amountCents: number;
  currency: string;
  cadence: "monthly" | "metered";
  includedUsage: string | null;
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
