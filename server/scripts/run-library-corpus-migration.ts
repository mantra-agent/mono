import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { proposeLibraryCorpusMigration } from "../library-corpus-migration";
import { createUserSessionPrincipal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { users } from "@shared/schema";

async function resolveUser() {
  const explicitUserId = process.env.LIBRARY_MIGRATION_USER_ID;
  if (explicitUserId) {
    const [user] = await db.select().from(users).where(eq(users.id, explicitUserId)).limit(1);
    if (!user) throw new Error(`LIBRARY_MIGRATION_USER_ID not found: ${explicitUserId}`);
    return user;
  }

  const candidates = await db.select().from(users).limit(2);
  if (candidates.length !== 1) {
    throw new Error("Set LIBRARY_MIGRATION_USER_ID; refusing to infer a user when the database does not have exactly one user.");
  }
  return candidates[0];
}

async function main() {
  const user = await resolveUser();
  const principal = await createUserSessionPrincipal(user);
  const idempotencyKey = process.env.LIBRARY_MIGRATION_IDEMPOTENCY_KEY || `library-corpus-migration:${new Date().toISOString().slice(0, 10)}`;
  const result = await runWithPrincipal(principal, () => proposeLibraryCorpusMigration({ idempotencyKey }, principal));
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
