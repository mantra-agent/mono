import { pgTable, text, integer, timestamp, serial, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────
export const passionTiers = ["mission", "value", "exploration"] as const;
export type PassionTier = typeof passionTiers[number];

export const skillCategories = ["technical", "business", "creative", "interpersonal", "domain"] as const;
export type SkillCategory = typeof skillCategories[number];

export const skillTypes = ["foundational", "applied", "tool", "domain"] as const;
export type SkillType = typeof skillTypes[number];

export const proficiencyLevels = ["novice", "developing", "competent", "proficient", "expert"] as const;
export type ProficiencyLevel = typeof proficiencyLevels[number];

export const energyLevels = ["draining", "neutral", "energizing", "flow"] as const;
export type EnergyLevel = typeof energyLevels[number];

// ── Tables ─────────────────────────────────────────────────────────
export const execSkills = pgTable("exec_skills", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  category: text("category"),
  skillType: text("skill_type").default("applied"),
  proficiency: text("proficiency"),
  energyLevel: text("energy_level"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const execExperience = pgTable("exec_experience", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  domain: text("domain").notNull(),
  narrative: text("narrative"),
  years: integer("years"),
  keyOutcomes: text("key_outcomes").array().notNull().default(sql`'{}'::text[]`),
  transferableAssets: text("transferable_assets").array().notNull().default(sql`'{}'::text[]`),
  startDate: text("start_date"),
  endDate: text("end_date"),
  company: text("company"),
  title: text("title"),
  location: text("location"),
  teamSizePeak: integer("team_size_peak"),
  directReports: integer("direct_reports"),
  pnlOwned: text("pnl_owned"),
  budgetManaged: text("budget_managed"),
  fundingRaised: text("funding_raised"),
  companyContext: text("company_context"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Verified, quantified accomplishments — the ONLY source resumes may
// draw numbers from. experienceId nullable: metrics can be standalone.
export const execMetrics = pgTable("exec_metrics", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("default"),
  experienceId: integer("experience_id"),
  metric: text("metric").notNull(),
  value: text("value").notNull(),
  context: text("context"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const execEducation = pgTable("exec_education", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("default"),
  institution: text("institution").notNull(),
  degree: text("degree"),
  field: text("field"),
  year: text("year"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const execPassions = pgTable("exec_passions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default("default"),
  tier: text("tier").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceRef: text("source_ref"),
  position: integer("position").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ── Join Tables ────────────────────────────────────────────────────
export const experienceSkills = pgTable("experience_skills", {
  id: serial("id").primaryKey(),
  experienceId: integer("experience_id").notNull(),
  skillId: integer("skill_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => [
  unique("uq_experience_skill").on(t.experienceId, t.skillId),
]);

// ── Zod Schemas ────────────────────────────────────────────────────
export const insertExecSkillSchema = createInsertSchema(execSkills).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1),
  category: z.enum(skillCategories).optional().nullable(),
  skillType: z.enum(skillTypes).optional().nullable(),
  proficiency: z.enum(proficiencyLevels).optional().nullable(),
  energyLevel: z.enum(energyLevels).optional().nullable(),
});

export const insertExecExperienceSchema = createInsertSchema(execExperience).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  domain: z.string().min(1),
  narrative: z.string().optional().nullable(),
  years: z.number().int().min(0).optional().nullable(),
  keyOutcomes: z.array(z.string()).optional(),
  transferableAssets: z.array(z.string()).optional(),
  startDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().nullable(),
  company: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  teamSizePeak: z.number().int().min(0).optional().nullable(),
  directReports: z.number().int().min(0).optional().nullable(),
  pnlOwned: z.string().optional().nullable(),
  budgetManaged: z.string().optional().nullable(),
  fundingRaised: z.string().optional().nullable(),
  companyContext: z.string().optional().nullable(),
});

export const insertExecMetricSchema = createInsertSchema(execMetrics).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  metric: z.string().min(1),
  value: z.string().min(1),
  experienceId: z.number().int().optional().nullable(),
  context: z.string().optional().nullable(),
  verifiedAt: z.coerce.date().optional().nullable(),
});

export const insertExecEducationSchema = createInsertSchema(execEducation).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  institution: z.string().min(1),
  degree: z.string().optional().nullable(),
  field: z.string().optional().nullable(),
  year: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const insertExecPassionSchema = createInsertSchema(execPassions).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  tier: z.enum(passionTiers),
  title: z.string().min(1),
  content: z.string().min(1),
  sourceRef: z.string().optional().nullable(),
  position: z.number().int().min(0).optional().nullable(),
});

// ── Types ──────────────────────────────────────────────────────────
export type ExecSkill = typeof execSkills.$inferSelect;
export type InsertExecSkill = z.infer<typeof insertExecSkillSchema>;
export type ExecExperience = typeof execExperience.$inferSelect;
export type InsertExecExperience = z.infer<typeof insertExecExperienceSchema>;
export type ExecPassion = typeof execPassions.$inferSelect;
export type InsertExecPassion = z.infer<typeof insertExecPassionSchema>;
export type ExperienceSkillRow = typeof experienceSkills.$inferSelect;
export type ExecMetric = typeof execMetrics.$inferSelect;
export type InsertExecMetric = z.infer<typeof insertExecMetricSchema>;
export type ExecEducationRow = typeof execEducation.$inferSelect;
export type InsertExecEducation = z.infer<typeof insertExecEducationSchema>;

// ── Artifact Content Contracts ─────────────────────────────────────
// Structured payloads the resume/cover-letter skills must emit before
// DOCX rendering. artifact-docx.ts validates against these schemas.
export const resumeContentSchema = z.object({
  name: z.string().min(1),
  targetTitle: z.string().min(1),
  contact: z.object({
    email: z.string().min(1),
    phone: z.string().min(1),
    linkedin: z.string().min(1),
    location: z.string().optional().nullable(),
  }),
  summary: z.string().min(1),
  competencies: z.array(z.string()).min(1),
  achievements: z.array(z.string()).optional().default([]),
  roles: z.array(z.object({
    company: z.string().min(1),
    title: z.string().min(1),
    dates: z.string().min(1),
    contextLine: z.string().optional().nullable(),
    bullets: z.array(z.string()),
  })).min(1),
  education: z.array(z.object({
    institution: z.string().min(1),
    degree: z.string().optional().nullable(),
    field: z.string().optional().nullable(),
    year: z.string().optional().nullable(),
  })).optional().default([]),
});
export type ResumeContent = z.infer<typeof resumeContentSchema>;

export const coverLetterContentSchema = z.object({
  name: z.string().min(1),
  contact: z.object({
    email: z.string().min(1),
    phone: z.string().min(1),
    linkedin: z.string().min(1),
  }),
  date: z.string().min(1),
  recipient: z.string().optional().nullable(),
  company: z.string().min(1),
  roleTitle: z.string().min(1),
  salutation: z.string().min(1),
  paragraphs: z.array(z.string().min(1)).min(2),
  closing: z.string().min(1),
});
export type CoverLetterContent = z.infer<typeof coverLetterContentSchema>;

/** Experience with eagerly-loaded linked skills */
export interface ExperienceWithSkills extends ExecExperience {
  linkedSkills: Array<{
    id: number;
    name: string;
    category: string | null;
    skillType: string | null;
    proficiency: string | null;
    energyLevel: string | null;
  }>;
}
