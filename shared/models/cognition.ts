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
    cognitiveOverrides: jsonb("cognitive_overrides").default({}), // Record<string, unknown>
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    source: text("source").notNull().default("user"), // seed | user
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    templatePersonaId: integer("template_persona_id"),
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

export const insertPersonaSchema = createInsertSchema(personas).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Persona = typeof personas.$inferSelect;
export type InsertPersona = z.infer<typeof insertPersonaSchema>;
