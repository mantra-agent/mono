import { pgTable, text, integer, timestamp, date, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────
export const thesisStatuses = ["draft", "active", "superseded", "invalidated"] as const;
export type ThesisStatus = typeof thesisStatuses[number];

export const thesisConvictions = ["low", "high"] as const;
export type ThesisConviction = typeof thesisConvictions[number];

export const predictionOutcomes = ["pending", "correct", "incorrect", "expired"] as const;
export type PredictionOutcome = typeof predictionOutcomes[number];

// ── Tables ─────────────────────────────────────────────────────────
export const theses = pgTable("theses", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  statement: text("statement").notNull().default(""),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").notNull().default("draft"),
  conviction: text("conviction").notNull().default("low"),
  successorId: text("successor_id"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_theses_status").on(table.status),
  index("idx_theses_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_theses_account").on(table.accountId),
]);

export const thesisEvidence = pgTable("thesis_evidence", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  thesisId: text("thesis_id").notNull().references(() => theses.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_thesis_evidence_thesis").on(table.thesisId),
]);

export const thesisPredictions = pgTable("thesis_predictions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  thesisId: text("thesis_id").notNull().references(() => theses.id, { onDelete: "cascade" }),
  claim: text("claim").notNull(),
  deadline: date("deadline"),
  outcome: text("outcome").notNull().default("pending"),
  conviction: text("conviction").notNull().default("low"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNotes: text("resolution_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_thesis_predictions_thesis").on(table.thesisId),
]);

// ── Zod Schemas ────────────────────────────────────────────────────
export const insertThesisSchema = createInsertSchema(theses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: z.enum(thesisStatuses).optional(),
  conviction: z.enum(thesisConvictions).optional(),
  tags: z.array(z.string()).optional(),
});

export const insertThesisEvidenceSchema = createInsertSchema(thesisEvidence).omit({
  id: true,
  createdAt: true,
}).extend({
  content: z.string().min(1),
  sourceUrl: z.string().optional(),
  position: z.number().int().optional(),
});

export const insertThesisPredictionSchema = createInsertSchema(thesisPredictions).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
}).extend({
  claim: z.string().min(1),
  deadline: z.string().nullable().optional(),
  outcome: z.enum(predictionOutcomes).optional(),
  conviction: z.enum(thesisConvictions).optional(),
  resolutionNotes: z.string().nullable().optional(),
});

// ── Types ──────────────────────────────────────────────────────────
export type Thesis = typeof theses.$inferSelect;
export type InsertThesis = z.infer<typeof insertThesisSchema>;
export type ThesisEvidence = typeof thesisEvidence.$inferSelect;
export type InsertThesisEvidence = z.infer<typeof insertThesisEvidenceSchema>;
export type ThesisPrediction = typeof thesisPredictions.$inferSelect;
export type InsertThesisPrediction = z.infer<typeof insertThesisPredictionSchema>;
