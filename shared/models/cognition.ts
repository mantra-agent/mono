import { semanticTierSchema } from "../model-connectors";
import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  real,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

// --- Emotional States ---

export const emotionalStates = pgTable(
  "emotional_states",
  {
    id: serial("id").primaryKey(),
    stateName: text("state_name").notNull(),
    valence: real("valence").notNull().default(0), // -1 (negative) to 1 (positive)
    arousal: real("arousal").notNull().default(0.5), // 0 (calm) to 1 (activated)
    triggers: text("triggers")
      .array()
      .default(sql`'{}'::text[]`),
    context: text("context").default(""),
    narrative: text("narrative"),
    source: text("source").notNull().default("explicit"), // explicit | inferred | behavioral
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_emotional_states_active").on(table.active),
    index("idx_emotional_states_created").on(table.createdAt),
    index("idx_emotional_states_scope_owner").on(
      table.scope,
      table.ownerUserId,
    ),
  ],
);

export const insertEmotionalStateSchema = createInsertSchema(
  emotionalStates,
).omit({
  id: true,
  createdAt: true,
});

export type EmotionalState = typeof emotionalStates.$inferSelect;
export type InsertEmotionalState = z.infer<typeof insertEmotionalStateSchema>;

// --- Personas ---

export const personas = pgTable(
  "personas",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").default(""),
    icon: text("icon").notNull().default("Bot"),
    promptOverlay: text("prompt_overlay"),
    expressionTags: jsonb("expression_tags").default([]), // string[]
    cognitiveOverrides: jsonb("cognitive_overrides").default({}),
    semanticTier: text("semantic_tier"), // Record<string, unknown>
    contextSections: jsonb("context_sections").default({}), // Record<string, boolean> — persona-owned context section bundle; single source of truth for which optional context sections load
    toolBundle: jsonb("tool_bundle").default([]), // string[] — tool names loaded with full schema for this persona, beyond the always-on core (consumed by tool tiering)
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    source: text("source").notNull().default("user"), // seed | user
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    // Rolling-deployment compatibility only. Persona ownership is user/account-wide;
    // runtime scope predicates and writes must never use this legacy column.
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    templatePersonaId: integer("template_persona_id"),
    baseRevisionId: text("base_revision_id"),
    currentRevisionId: text("current_revision_id"),
    updateState: text("update_state").notNull().default("pinned_legacy"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_personas_active").on(table.isActive),
    index("idx_personas_default").on(table.isDefault),
    index("idx_personas_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_personas_account").on(table.accountId),
  ],
);

export const personaRevisions = pgTable(
  "persona_revisions",
  {
    id: text("id").primaryKey(),
    personaIdentityId: integer("persona_identity_id").notNull().references(() => personas.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    parentRevisionId: text("parent_revision_id"),
    platformBaseRevisionId: text("platform_base_revision_id"),
    payload: jsonb("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    changeSummary: text("change_summary").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (table) => [
    index("idx_persona_revisions_identity_created").on(table.personaIdentityId, table.createdAt),
    index("idx_persona_revisions_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_persona_revisions_identity_hash").on(table.personaIdentityId, table.contentHash),
  ],
);

export type PersonaRevision = typeof personaRevisions.$inferSelect;

export const personaPreferences = pgTable(
  "persona_preferences",
  {
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    defaultPersonaId: integer("default_persona_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("persona_preferences_owner_account_key").on(table.ownerUserId, table.accountId),
    index("idx_persona_preferences_default").on(table.defaultPersonaId),
  ],
);

export type PersonaPreference = typeof personaPreferences.$inferSelect;

export const insertPersonaSchema = createInsertSchema(personas, { semanticTier: semanticTierSchema.nullable().optional() }).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Persona = typeof personas.$inferSelect;
export type InsertPersona = z.infer<typeof insertPersonaSchema>;
