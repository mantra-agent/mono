import { sql } from "drizzle-orm";
import { boolean, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod";
import { vaults } from "./vaults";

// A Business is the missing owner noun: everything business-scoped (Definition,
// Business Plans, KPIs, Metrics) references the Business, not the vault. The
// vault returns to pure storage/visibility, resolved through
// business_vault_memberships — the exact idiom People uses.
export const businesses = pgTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    // Display/brand name.
    publicName: text("public_name").notNull(),
    // Legal entity name; null until known.
    entityName: text("entity_name"),
    // Fixed narrative slots, each a soft reference to a Library page (canonical
    // reference system), like People's referenced pages. Null until the page is
    // created. Soft refs mirror business_plans.thematic_goal_id rather than a
    // hard DB FK so page deletion never blocks a Business.
    valuesPageId: text("values_page_id"),
    visionPageId: text("vision_page_id"),
    missionPageId: text("mission_page_id"),
    phasesPageId: text("phases_page_id"),
    pitchPageId: text("pitch_page_id"),
    gtmPageId: text("gtm_page_id"),
    // User-configured external destination for the Business data room. The
    // server mutation boundary accepts HTTPS URLs only.
    dataRoomUrl: text("data_room_url"),
    status: text("status").notNull().default("active"),
    // Stable capability identity for Mantra's own platform telemetry. Public and
    // legal names remain presentation and may change without moving adapters.
    isPlatformInstrument: boolean("is_platform_instrument").notNull().default(false),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_businesses_owner").on(table.ownerUserId, table.accountId),
    index("idx_businesses_scope_owner").on(table.scope, table.ownerUserId),
    uniqueIndex("businesses_account_platform_instrument_uidx")
      .on(table.accountId)
      .where(sql`${table.isPlatformInstrument} = true`),
  ],
);

export type BusinessRow = typeof businesses.$inferSelect;

// Mirrors person_vault_memberships exactly: a Business is visible when at least
// one membership resolves to a currently visible live vault in the principal
// account.
export const businessVaultMemberships = pgTable(
  "business_vault_memberships",
  {
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.vaultId] }),
    index("idx_business_vault_memberships_vault_business").on(table.vaultId, table.businessId),
    index("idx_business_vault_memberships_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_business_vault_memberships_account").on(table.accountId),
  ],
);

export type BusinessVaultMembership = typeof businessVaultMemberships.$inferSelect;

export const businessStatusSchema = z.enum(["active", "archived"]);

export const businessCreateSchema = z.object({
  publicName: z.string().trim().min(1).max(160),
  entityName: z.string().trim().min(1).max(200).nullable().optional(),
  valuesPageId: z.string().min(1).nullable().optional(),
  visionPageId: z.string().min(1).nullable().optional(),
  missionPageId: z.string().min(1).nullable().optional(),
  phasesPageId: z.string().min(1).nullable().optional(),
  pitchPageId: z.string().min(1).nullable().optional(),
  gtmPageId: z.string().min(1).nullable().optional(),
  dataRoomUrl: z.string().url().max(2048).refine((value) => new URL(value).protocol === "https:", "Data Room URL must use HTTPS").nullable().optional(),
  vaultIds: z.array(z.string().min(1)).max(64).optional(),
});

export const businessPatchSchema = z
  .object({
    publicName: z.string().trim().min(1).max(160).optional(),
    // null clears the entity name; omit leaves it unchanged.
    entityName: z.string().trim().min(1).max(200).nullable().optional(),
    valuesPageId: z.string().min(1).nullable().optional(),
    visionPageId: z.string().min(1).nullable().optional(),
    missionPageId: z.string().min(1).nullable().optional(),
    phasesPageId: z.string().min(1).nullable().optional(),
    pitchPageId: z.string().min(1).nullable().optional(),
    gtmPageId: z.string().min(1).nullable().optional(),
    dataRoomUrl: z.string().url().max(2048).refine((value) => new URL(value).protocol === "https:", "Data Room URL must use HTTPS").nullable().optional(),
    status: businessStatusSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, "At least one change is required");

export type BusinessStatus = z.infer<typeof businessStatusSchema>;
export type BusinessCreate = z.infer<typeof businessCreateSchema>;
export type BusinessPatch = z.infer<typeof businessPatchSchema>;
