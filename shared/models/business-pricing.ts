import { z } from "zod";

export const PRICING_PACKAGE_KEYS = ["max", "max_plus", "factory_plus"] as const;
export type PricingPackageKey = (typeof PRICING_PACKAGE_KEYS)[number];

export const pricingRouterSchema = z.enum(["default", "dedicated"]);
export const pricingCustomizationSchema = z.enum(["standard", "software_factory"]);
export const pricingSupportSchema = z.enum(["activation_concierge", "elite_concierge"]);

const moneySchema = z.number().finite().min(0).max(1_000_000_000);
const countSchema = z.number().int().min(0).max(1_000_000);
const nameSchema = z.string().trim().min(1).max(80);

export const pricingPackageKeySchema = z.enum(PRICING_PACKAGE_KEYS);

export const pricingPackageSchema = z.object({
  key: pricingPackageKeySchema,
  name: nameSchema,
  listMonthly: moneySchema,
  yearOneCash: moneySchema,
  yearTwoMonthly: moneySchema,
  includedAgents: countSchema,
  includedPrincipals: countSchema,
  includedParticipants: countSchema.nullable(),
  extraAgentMonthly: moneySchema.nullable(),
  extraPrincipalMonthly: moneySchema.nullable(),
  extraParticipantMonthly: moneySchema.nullable(),
  includedTokensMillions: z.number().finite().min(0).max(1_000_000),
  factory: z.boolean(),
  router: pricingRouterSchema,
  customization: pricingCustomizationSchema,
  support: pricingSupportSchema,
});

export const pricingExtrasSchema = z.object({
  extraUsagePerMillion: moneySchema,
  workhorseInputPerMillion: moneySchema,
});

export type PricingPackage = z.infer<typeof pricingPackageSchema>;
export type PricingExtras = z.infer<typeof pricingExtrasSchema>;

export interface PricingPackageView extends PricingPackage {
  yearOneMonthly: number;
}

export interface BusinessPricing {
  id: string;
  businessId: string;
  packages: PricingPackageView[];
  extras: PricingExtras;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_PRICING_EXTRAS: PricingExtras = {
  extraUsagePerMillion: 3,
  workhorseInputPerMillion: 2,
};

export const DEFAULT_PRICING_PACKAGES: Record<PricingPackageKey, Omit<PricingPackage, "key">> = {
  max: {
    name: "Max",
    listMonthly: 500,
    yearOneCash: 10_000,
    yearTwoMonthly: 450,
    includedAgents: 1,
    includedPrincipals: 1,
    includedParticipants: 0,
    extraAgentMonthly: null,
    extraPrincipalMonthly: null,
    extraParticipantMonthly: 200,
    includedTokensMillions: 50,
    factory: false,
    router: "default",
    customization: "standard",
    support: "activation_concierge",
  },
  max_plus: {
    name: "Max+",
    listMonthly: 1_000,
    yearOneCash: 20_000,
    yearTwoMonthly: 900,
    includedAgents: 1,
    includedPrincipals: 1,
    includedParticipants: 3,
    extraAgentMonthly: 1_000,
    extraPrincipalMonthly: 500,
    extraParticipantMonthly: 200,
    includedTokensMillions: 150,
    factory: false,
    router: "default",
    customization: "standard",
    support: "elite_concierge",
  },
  factory_plus: {
    name: "Factory+",
    listMonthly: 5_000,
    yearOneCash: 90_000,
    yearTwoMonthly: 5_000,
    includedAgents: 1,
    includedPrincipals: 4,
    includedParticipants: null,
    extraAgentMonthly: 1_000,
    extraPrincipalMonthly: 500,
    extraParticipantMonthly: null,
    includedTokensMillions: 1_000,
    factory: true,
    router: "dedicated",
    customization: "software_factory",
    support: "elite_concierge",
  },
};

const PACKAGE_CLEARABLE = [
  "includedParticipants",
  "extraAgentMonthly",
  "extraPrincipalMonthly",
  "extraParticipantMonthly",
] as const;

export const pricingPackagePatchSchema = z.object({
  name: nameSchema.optional(),
  listMonthly: moneySchema.optional(),
  yearOneCash: moneySchema.optional(),
  yearTwoMonthly: moneySchema.optional(),
  includedAgents: countSchema.optional(),
  includedPrincipals: countSchema.optional(),
  includedParticipants: countSchema.optional(),
  extraAgentMonthly: moneySchema.optional(),
  extraPrincipalMonthly: moneySchema.optional(),
  extraParticipantMonthly: moneySchema.optional(),
  includedTokensMillions: z.number().finite().min(0).max(1_000_000).optional(),
  factory: z.boolean().optional(),
  router: pricingRouterSchema.optional(),
  customization: pricingCustomizationSchema.optional(),
  support: pricingSupportSchema.optional(),
  clearFields: z.array(z.enum(PACKAGE_CLEARABLE)).max(PACKAGE_CLEARABLE.length).optional(),
}).strict();

export const pricingExtrasPatchSchema = z.object({
  extraUsagePerMillion: moneySchema.optional(),
  workhorseInputPerMillion: moneySchema.optional(),
}).strict();

export const businessPricingMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_package"),
    key: pricingPackageKeySchema,
    patch: pricingPackagePatchSchema,
  }),
  z.object({
    action: z.literal("update_extras"),
    patch: pricingExtrasPatchSchema,
  }),
]);

export type BusinessPricingMutation = z.infer<typeof businessPricingMutationSchema>;
export type PricingPackagePatch = z.infer<typeof pricingPackagePatchSchema>;
export type PricingExtrasPatch = z.infer<typeof pricingExtrasPatchSchema>;

export function yearOneMonthly(yearOneCash: number): number {
  return yearOneCash / 12;
}

export function seedPricingPackages(): PricingPackage[] {
  return PRICING_PACKAGE_KEYS.map((key) => ({ key, ...DEFAULT_PRICING_PACKAGES[key] }));
}

export function applyPackageInvariants(pkg: PricingPackage): PricingPackage {
  const next = { ...pkg };
  if (next.key === "max") {
    next.extraAgentMonthly = null;
    next.extraPrincipalMonthly = null;
  }
  if (next.includedParticipants === null) next.extraParticipantMonthly = null;
  return pricingPackageSchema.parse(next);
}

export function projectPackage(pkg: PricingPackage): PricingPackageView {
  const normalized = applyPackageInvariants(pkg);
  return { ...normalized, yearOneMonthly: yearOneMonthly(normalized.yearOneCash) };
}

export function normalizePricingPackages(raw: unknown): PricingPackage[] {
  const byKey = new Map<PricingPackageKey, PricingPackage>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = pricingPackageSchema.safeParse(item);
      if (parsed.success) byKey.set(parsed.data.key, parsed.data);
    }
  } else if (raw && typeof raw === "object") {
    for (const key of PRICING_PACKAGE_KEYS) {
      const candidate = (raw as Record<string, unknown>)[key];
      const parsed = pricingPackageSchema.safeParse(
        candidate && typeof candidate === "object" ? { key, ...(candidate as object) } : candidate,
      );
      if (parsed.success) byKey.set(key, parsed.data);
    }
  }
  return PRICING_PACKAGE_KEYS.map((key) => applyPackageInvariants(byKey.get(key) ?? { key, ...DEFAULT_PRICING_PACKAGES[key] }));
}

export function normalizePricingExtras(raw: unknown): PricingExtras {
  const parsed = pricingExtrasSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_PRICING_EXTRAS };
}

export function applyPackagePatch(current: PricingPackage, patch: PricingPackagePatch): PricingPackage {
  const next: PricingPackage = { ...current };
  const clear = new Set(patch.clearFields ?? []);
  for (const field of PACKAGE_CLEARABLE) {
    if (clear.has(field)) (next as Record<string, unknown>)[field] = null;
  }
  const { clearFields: _clearFields, ...fields } = patch;
  Object.assign(next, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
  return applyPackageInvariants(next);
}

export function applyExtrasPatch(current: PricingExtras, patch: PricingExtrasPatch): PricingExtras {
  return pricingExtrasSchema.parse({
    extraUsagePerMillion: patch.extraUsagePerMillion ?? current.extraUsagePerMillion,
    workhorseInputPerMillion: patch.workhorseInputPerMillion ?? current.workhorseInputPerMillion,
  });
}
