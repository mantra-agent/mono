import { pgTable, text, integer, timestamp, serial, real, boolean, jsonb, unique, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────
export const opportunityTypes = ["job", "consulting", "business", "passive_income"] as const;
export type OpportunityType = typeof opportunityTypes[number];

export const opportunityStatuses = ["discovered", "qualified", "researched", "pursuing", "active", "passed", "lost"] as const;
export type OpportunityStatus = typeof opportunityStatuses[number];

export const opportunityPriorities = ["high", "mid", "low"] as const;
export type OpportunityPriority = typeof opportunityPriorities[number];

export const sourceTypes = ["manual", "landscape", "referral"] as const;
export type SourceType = typeof sourceTypes[number];

export const commitmentPeriods = ["week", "month"] as const;
export type CommitmentPeriod = typeof commitmentPeriods[number];

// ── Tables ─────────────────────────────────────────────────────────
export const opportunities = pgTable("opportunities", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").notNull(),
  status: text("status").notNull().default("discovered"),
  probability: real("probability").notNull().default(0.05),
  isFullTime: boolean("is_full_time").notNull().default(false),
  hoursPerWeek: integer("hours_per_week"),
  timeCommitmentPeriod: text("time_commitment_period").default("week"),
  timeHorizonMonths: integer("time_horizon_months"),
  evInputs: jsonb("ev_inputs").notNull().default(sql`'{}'::jsonb`),
  computedEv: real("computed_ev"),
  company: text("company"),
  location: text("location"),
  nextSteps: text("next_steps"),
  priority: text("priority"),
  contactPersonId: text("contact_person_id"),
  sourceType: text("source_type").notNull().default("manual"),
  sourceSignalId: text("source_signal_id"),
  requiredSkills: text("required_skills").array().notNull().default(sql`'{}'::text[]`),
  jdText: text("jd_text"),
  jobUrl: text("job_url"),
  championPersonId: text("champion_person_id"),
  followUpBy: text("follow_up_by"),
  followUpNote: text("follow_up_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => [
  index("idx_opportunities_scope_owner").on(t.scope, t.ownerUserId),
  index("idx_opportunities_account").on(t.accountId),
]);

export const opportunitySkills = pgTable("opportunity_skills", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull(),
  skillId: integer("skill_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => [
  unique("uq_opportunity_skill").on(t.opportunityId, t.skillId),
]);


// ── Opportunity activity associations ─────────────────────────────
// Interactions remain canonical inside the owning Person record. This
// table stores only the principal-owned many-to-many association.
export const opportunityInteractions = pgTable("opportunity_interactions", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull(),
  personId: text("person_id").notNull(),
  interactionId: text("interaction_id").notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => [
  unique("uq_opportunity_interaction").on(t.opportunityId, t.personId, t.interactionId),
  index("idx_opportunity_interactions_opportunity").on(t.opportunityId),
  index("idx_opportunity_interactions_interaction").on(t.personId, t.interactionId),
  index("idx_opportunity_interactions_scope_owner").on(t.scope, t.ownerUserId),
  index("idx_opportunity_interactions_account").on(t.accountId),
]);

export const interactionTypes = ["message", "call", "meeting", "email", "note", "text", "in_person", "video", "social", "gift", "introduction", "favor", "support"] as const;
export const interactionDirections = ["inbound", "outbound", "mutual"] as const;
export const interactionMeaningfulness = ["high", "medium", "low"] as const;
export const interactionCapitalImpacts = ["deposit", "withdrawal", "neutral"] as const;

export const createOpportunityInteractionSchema = z.object({
  personId: z.string().min(1),
  interactionId: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  type: z.enum(interactionTypes).optional(),
  summary: z.string().min(1).optional(),
  context: z.string().optional(),
  direction: z.enum(interactionDirections).optional(),
  meaningfulness: z.enum(interactionMeaningfulness).optional(),
  responseOwed: z.boolean().optional(),
  responseDueBy: z.string().optional().nullable(),
  capitalImpact: z.enum(interactionCapitalImpacts).optional(),
  tags: z.array(z.string()).optional(),
}).superRefine((value, context) => {
  if (!value.interactionId && !value.summary) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "summary is required when creating a new interaction", path: ["summary"] });
  }
});

export const updateOpportunityInteractionSchema = z.object({
  date: z.string().min(1).optional(),
  type: z.enum(interactionTypes).optional(),
  summary: z.string().min(1).optional(),
  context: z.string().optional(),
  direction: z.enum(interactionDirections).optional(),
  meaningfulness: z.enum(interactionMeaningfulness).optional(),
  responseOwed: z.boolean().optional(),
  responseDueBy: z.string().optional().nullable(),
  capitalImpact: z.enum(interactionCapitalImpacts).optional(),
  tags: z.array(z.string()).optional(),
});

export type OpportunityInteractionRow = typeof opportunityInteractions.$inferSelect;
export type CreateOpportunityInteractionInput = z.infer<typeof createOpportunityInteractionSchema>;
export type UpdateOpportunityInteractionInput = z.infer<typeof updateOpportunityInteractionSchema>;

export interface OpportunityInteractionActivity {
  associationId: number;
  opportunityId: number;
  personId: string;
  personName: string;
  interaction: {
    id: string;
    date: string;
    type: string;
    summary: string;
    context?: string;
    direction?: "inbound" | "outbound" | "mutual";
    meaningfulness?: "high" | "medium" | "low";
    responseOwed?: boolean;
    responseDueBy?: string;
    capitalImpact?: "deposit" | "withdrawal" | "neutral";
    tags?: string[];
  };
  reference: string;
  createdAt: Date;
}

// ── Artifact Slots ─────────────────────────────────────────────────
// Each opportunity has up to one artifact per kind. The slot row maps
// the kind to a stable Library page (replace-in-place on regeneration)
// plus the last generating session and optional rendered DOCX.
export const artifactKinds = ["research", "cover_letter", "resume"] as const;
export type ArtifactKind = typeof artifactKinds[number];

export const opportunityArtifacts = pgTable("opportunity_artifacts", {
  id: serial("id").primaryKey(),
  opportunityId: integer("opportunity_id").notNull(),
  kind: text("kind").notNull(),
  libraryPageId: text("library_page_id").notNull(),
  sessionId: text("session_id"),
  docxFileName: text("docx_file_name"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => [
  unique("uq_opportunity_artifact_kind").on(t.opportunityId, t.kind),
]);

// ── EV Computation ─────────────────────────────────────────────────
export function computeEV(
  type: string,
  evInputs: Record<string, any>,
  probability: number,
  hoursPerWeek?: number | null,
): number {
  switch (type) {
    case "job":
      return (evInputs.annualComp || 0) * probability;

    case "consulting": {
      const hpw = hoursPerWeek ?? evInputs.hoursPerWeek ?? 0;
      const weeklyIncome = (evInputs.rate || 0) * hpw;
      const totalIncome = weeklyIncome * 4.33 * (evInputs.durationMonths || 1);
      return totalIncome * probability;
    }

    case "business": {
      let bizTotal = 0;
      const months = evInputs.projectionMonths || 12;
      for (let m = 0; m < months; m++) {
        const monthlyRev = evInputs.monthlyRevenue || (evInputs.annualRevenue ? evInputs.annualRevenue / 12 : 0);
        const revenue = monthlyRev * Math.pow(1 + (evInputs.growthRate || 0), m);
        bizTotal += revenue * (evInputs.margin || 1);
      }
      return bizTotal * probability;
    }

    case "passive_income": {
      let passiveTotal = 0;
      const pMonths = evInputs.projectionMonths || 12;
      for (let m = 0; m < pMonths; m++) {
        passiveTotal += (evInputs.monthlyYield || 0) * Math.pow(1 + (evInputs.growthRate || 0), m);
      }
      return passiveTotal * probability;
    }

    default:
      return 0;
  }
}

// ── Zod Schemas ────────────────────────────────────────────────────
export const insertOpportunitySchema = createInsertSchema(opportunities).omit({
  id: true,
  userId: true,
  computedEv: true,
  createdAt: true,
  updatedAt: true,
  scope: true,
  ownerUserId: true,
  accountId: true,
}).extend({
  title: z.string().min(1),
  type: z.enum(opportunityTypes),
  status: z.enum(opportunityStatuses).optional(),
  probability: z.number().min(0).max(1).optional(),
  isFullTime: z.boolean().optional(),
  hoursPerWeek: z.number().int().min(0).optional().nullable(),
  timeCommitmentPeriod: z.enum(commitmentPeriods).optional(),
  timeHorizonMonths: z.number().int().min(0).optional().nullable(),
  evInputs: z.record(z.any()).optional(),
  company: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  nextSteps: z.string().optional().nullable(),
  priority: z.enum(opportunityPriorities).optional().nullable(),
  contactPersonId: z.string().optional().nullable(),
  sourceType: z.enum(sourceTypes).optional(),
  sourceSignalId: z.string().optional().nullable(),
  requiredSkills: z.array(z.string()).optional(),
  description: z.string().optional().nullable(),
  jdText: z.string().optional().nullable(),
  jobUrl: z.string().optional().nullable(),
  championPersonId: z.string().optional().nullable(),
  followUpBy: z.string().optional().nullable(),
  followUpNote: z.string().optional().nullable(),
});

// ── Types ──────────────────────────────────────────────────────────
export type OpportunityRow = typeof opportunities.$inferSelect;
export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type OpportunitySkillRow = typeof opportunitySkills.$inferSelect;
export type OpportunityArtifactRow = typeof opportunityArtifacts.$inferSelect;

/** Opportunity with linked skills joined in */
export interface OpportunityWithSkills extends OpportunityRow {
  linkedSkills?: Array<{
    id: number;
    name: string;
    category: string | null;
    skillType: string | null;
    proficiency: string | null;
    energyLevel: string | null;
  }>;
}
