import { sql } from "drizzle-orm";
import { ADVISORY_LOCK_NS, db } from "../db";
import { createLogger } from "../log";

const log = createLogger("RetireRegressionDomain");

/**
 * Terminal schema retirement for the removed Regression product domain.
 *
 * The ordinary post-build path is Timer -> Skill -> principal-scoped Issues.
 * These tables have no runtime reader or writer after this migration and are
 * intentionally dropped rather than retained as a second source of truth.
 */
export async function retireRegressionDomainSchema(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NS.REGRESSION_RETIREMENT}::int4, 1::int4)`,
    );
    await tx.execute(sql`DROP TABLE IF EXISTS issue_regression_results`);
    await tx.execute(sql`DROP TABLE IF EXISTS issue_regression_contracts`);
    await tx.execute(sql`DROP TABLE IF EXISTS regression_runs`);
    await tx.execute(sql`DROP FUNCTION IF EXISTS prevent_issue_regression_result_mutation()`);
  });
  log.info("retired Regression domain schema");
}
