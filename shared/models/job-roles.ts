import { z } from "zod";

export const JOB_TEAMS = [
  "Executive",
  "Product",
  "Engineering",
  "Design",
  "Go-to-Market",
  "Customer Success",
  "Operations",
  "Finance",
  "People",
] as const;

export type JobTeam = (typeof JOB_TEAMS)[number];

const titleSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().max(20_000);
const salarySchema = z.number().int().min(0).max(10_000_000);
const bonusSchema = z.number().min(0).max(1_000);
const equitySchema = z.number().int().min(0).max(1_000_000_000);
const pageIdSchema = z.string().trim().min(1).max(200);

export const jobRoleCreateSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.default(""),
  team: z.enum(JOB_TEAMS).default("Engineering"),
  annualSalaryMin: salarySchema.default(0),
  annualSalaryMax: salarySchema.default(0),
  targetBonusPercent: bonusSchema.default(0),
  equityShareCount: equitySchema.default(0),
  scorecardPageId: pageIdSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.annualSalaryMax < value.annualSalaryMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["annualSalaryMax"],
      message: "Annual salary maximum must be greater than or equal to the minimum",
    });
  }
});

export const jobRoleUpdateSchema = z.object({
  title: titleSchema.optional(),
  description: descriptionSchema.optional(),
  team: z.enum(JOB_TEAMS).optional(),
  annualSalaryMin: salarySchema.optional(),
  annualSalaryMax: salarySchema.optional(),
  targetBonusPercent: bonusSchema.optional(),
  equityShareCount: equitySchema.optional(),
  scorecardPageId: pageIdSchema.nullable().optional(),
  clearFields: z.array(z.enum(["description", "scorecardPageId"])).max(2).optional(),
}).strict();

export interface JobRoleScorecardPage {
  id: string;
  title: string;
  slug: string;
}

export interface JobRole {
  id: string;
  title: string;
  description: string;
  team: JobTeam;
  annualSalaryMin: number;
  annualSalaryMax: number;
  targetBonusPercent: number;
  equityShareCount: number;
  scorecardPageId: string | null;
  scorecardPage: JobRoleScorecardPage | null;
  createdAt: string;
  updatedAt: string;
}

export type JobRoleCreate = z.infer<typeof jobRoleCreateSchema>;
export type JobRoleUpdate = z.infer<typeof jobRoleUpdateSchema>;

export function normalizeJobRoleTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
