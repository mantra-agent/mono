import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { platformProductEnvironments } from "./platforms";

/**
 * Immutable, account-owned provider evidence. Provider payloads are reduced to
 * the bounded fields needed to identify and render one successful deployment.
 */
export const platformDeploymentObservations = pgTable(
  "platform_deployment_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformEnvironmentId: integer("platform_environment_id")
      .notNull()
      .references(() => platformProductEnvironments.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    providerDeploymentId: text("provider_deployment_id").notNull(),
    deploymentState: text("deployment_state").notNull(),
    platformName: text("platform_name").notNull(),
    productName: text("product_name").notNull(),
    environmentName: text("environment_name").notNull(),
    commitSha: text("commit_sha"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uk_platform_deployment_observation_provider_identity").on(
      table.accountId,
      table.platformEnvironmentId,
      table.provider,
      table.providerDeploymentId,
    ),
    index("idx_platform_deployment_observations_owner_time").on(
      table.ownerUserId,
      table.accountId,
      table.deployedAt,
    ),
    check("platform_deployment_observations_provider_check", sql`${table.provider} = 'railway'`),
    check("platform_deployment_observations_state_check", sql`${table.deploymentState} = 'SUCCESS'`),
    check(
      "platform_deployment_observations_provider_id_check",
      sql`char_length(${table.providerDeploymentId}) BETWEEN 1 AND 200`,
    ),
    check(
      "platform_deployment_observations_identity_check",
      sql`char_length(${table.platformName}) BETWEEN 1 AND 200
        AND char_length(${table.productName}) BETWEEN 1 AND 200
        AND char_length(${table.environmentName}) BETWEEN 1 AND 200`,
    ),
    check(
      "platform_deployment_observations_commit_check",
      sql`${table.commitSha} IS NULL OR char_length(${table.commitSha}) BETWEEN 1 AND 200`,
    ),
  ],
);

/**
 * Build-owned Home projection lifecycle. Absence means not projected; one row
 * means the observation was projected exactly once, with dismissal retained.
 */
export const buildDeploymentHomeProjections = pgTable(
  "build_deployment_home_projections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => platformDeploymentObservations.id, { onDelete: "restrict" }),
    reasonKey: text("reason_key").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedByUserId: text("dismissed_by_user_id"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uk_build_deployment_home_projection_observation").on(table.observationId),
    uniqueIndex("uk_build_deployment_home_projection_reason").on(table.accountId, table.reasonKey),
    index("idx_build_deployment_home_projection_owner").on(
      table.ownerUserId,
      table.accountId,
      table.dismissedAt,
      table.createdAt,
    ),
    check(
      "build_deployment_home_projection_reason_check",
      sql`char_length(${table.reasonKey}) BETWEEN 1 AND 500`,
    ),
    check(
      "build_deployment_home_projection_dismissal_check",
      sql`(${table.dismissedAt} IS NULL AND ${table.dismissedByUserId} IS NULL)
        OR (${table.dismissedAt} IS NOT NULL AND ${table.dismissedByUserId} IS NOT NULL)`,
    ),
  ],
);

export type PlatformDeploymentObservation = typeof platformDeploymentObservations.$inferSelect;
export type BuildDeploymentHomeProjection = typeof buildDeploymentHomeProjections.$inferSelect;
