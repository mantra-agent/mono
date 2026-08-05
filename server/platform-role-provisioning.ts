import { createHash, randomBytes } from "crypto";
import { Client } from "pg";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { privilegedAccessAudit } from "@shared/schema";
import {
  environmentHostingBindings,
  platformProductEnvironments,
  providerConnections,
} from "@shared/models/platforms";
import { getProviderCredential } from "./provider-credential-store";
import {
  fetchServiceVariables,
  redeployServiceInstance,
  upsertServiceVariables,
} from "./integrations/railway/client";

export const ROLE_PROVISION_CONFIRMATION = "PROVISION RESTRICTED DATABASE ROLES";
const OPERATION = "platform.provision_database_roles";
const ROLE_NAMES = ["mantra_app", "mantra_system", "mantra_migrator"] as const;

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function connectionUrl(source: string, username: string, password: string): string {
  const url = new URL(source);
  url.username = username;
  url.password = password;
  return url.toString();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export async function provisionDatabaseRoles(args: {
  environmentId: number;
  idempotencyKey: string;
  confirmation: string;
  allowLive?: boolean;
  actorUserId?: string | null;
}): Promise<Record<string, unknown>> {
  if (args.confirmation !== ROLE_PROVISION_CONFIRMATION) {
    throw new Error(`Explicit confirmation required: ${ROLE_PROVISION_CONFIRMATION}`);
  }
  if (!args.idempotencyKey.trim()) throw new Error("idempotencyKey is required");

  const [target] = await db
    .select({
      environmentName: platformProductEnvironments.name,
      provider: environmentHostingBindings.provider,
      connectionId: environmentHostingBindings.connectionId,
      projectId: environmentHostingBindings.projectId,
      providerEnvironmentId: environmentHostingBindings.providerEnvironmentId,
      serviceId: environmentHostingBindings.serviceId,
      providerKind: providerConnections.provider,
    })
    .from(platformProductEnvironments)
    .innerJoin(environmentHostingBindings, eq(environmentHostingBindings.environmentId, platformProductEnvironments.id))
    .leftJoin(providerConnections, eq(providerConnections.id, environmentHostingBindings.connectionId))
    .where(eq(platformProductEnvironments.id, args.environmentId))
    .limit(1);
  if (!target) throw new Error("Platform Environment or hosting binding not found");
  const normalizedName = target.environmentName.trim().toLowerCase();
  const isLive = normalizedName === "live" || normalizedName === "production" || normalizedName === "prod";
  if (isLive && args.allowLive !== true) throw new Error("Live provisioning is denied by default; separate allowLive authorization is required");
  if (target.provider !== "railway" || target.providerKind !== "railway" || !target.connectionId) {
    throw new Error("Provisioning requires an authenticated Railway hosting binding");
  }
  if (!target.projectId || !target.providerEnvironmentId || !target.serviceId) {
    throw new Error("Railway hosting binding is incomplete");
  }

  const [prior] = await db
    .select({ metadata: privilegedAccessAudit.metadata })
    .from(privilegedAccessAudit)
    .where(and(eq(privilegedAccessAudit.action, OPERATION), sql`${privilegedAccessAudit.metadata}->>'idempotencyKey' = ${args.idempotencyKey}`))
    .orderBy(desc(privilegedAccessAudit.createdAt))
    .limit(1);
  if ((prior?.metadata as Record<string, unknown> | undefined)?.status === "succeeded") {
    return { environmentId: args.environmentId, replayed: true, status: "succeeded", roles: ROLE_NAMES, secretsReturned: false };
  }

  const credential = await getProviderCredential(target.connectionId);
  if (!credential) throw new Error("Railway credential unavailable");
  const variables = await fetchServiceVariables(target.projectId, target.providerEnvironmentId, target.serviceId, credential);
  const adminUrl = variables.DATABASE_URL;
  if (!adminUrl) throw new Error("Bound Railway service does not expose DATABASE_URL");

  const passwords = { mantra_app: secret(), mantra_system: secret(), mantra_migrator: secret() };
  const client = new Client({ connectionString: adminUrl, application_name: "mantra-role-provisioner" });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${OPERATION}:${args.environmentId}`]);
    for (const role of ROLE_NAMES) {
      await client.query(`DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $role$;`);
      await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD $1`, [passwords[role]]);
    }
    await client.query("ALTER ROLE mantra_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await client.query("ALTER ROLE mantra_system NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS");
    await client.query("ALTER ROLE mantra_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS");
    await client.query("GRANT CONNECT ON DATABASE current_database() TO mantra_app, mantra_system, mantra_migrator");
    await client.query("GRANT USAGE ON SCHEMA public TO mantra_app, mantra_system, mantra_migrator");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mantra_app, mantra_system");
    await client.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mantra_app, mantra_system");
    await client.query("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO mantra_migrator");
    await client.query("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO mantra_migrator");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }

  await upsertServiceVariables(target.projectId, target.providerEnvironmentId, target.serviceId, {
    DATABASE_URL: connectionUrl(adminUrl, "mantra_app", passwords.mantra_app),
    SYSTEM_DATABASE_URL: connectionUrl(adminUrl, "mantra_system", passwords.mantra_system),
    MIGRATOR_DATABASE_URL: connectionUrl(adminUrl, "mantra_migrator", passwords.mantra_migrator),
  }, credential);
  const redeployTriggered = await redeployServiceInstance(target.serviceId, target.providerEnvironmentId, credential);

  const evidence = {
    idempotencyKey: args.idempotencyKey,
    status: "succeeded",
    environmentId: args.environmentId,
    environmentName: target.environmentName,
    provider: "railway",
    roles: ROLE_NAMES,
    roleFingerprint: fingerprint(ROLE_NAMES.join(":")),
    variablesPersisted: ["DATABASE_URL", "SYSTEM_DATABASE_URL", "MIGRATOR_DATABASE_URL"],
    secretsReturned: false,
    redeployTriggered,
  };
  await db.insert(privilegedAccessAudit).values({
    actorType: "agent",
    actorUserId: args.actorUserId ?? null,
    action: OPERATION,
    resourceType: "platform_environment",
    resourceId: String(args.environmentId),
    metadata: evidence,
  });
  return { ...evidence, replayed: false };
}
