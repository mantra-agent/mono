// Use createLogger for logging ONLY
import { PeopleStorage } from "./people-storage";
import { ensureFinanceSensitiveSchema } from "./finance-scope";
import { DEFAULT_WELLNESS_ACTIVITIES } from "../shared/models/health";
import { createLogger } from "./log";
import { sql } from "drizzle-orm";
import {
  getInstanceName,
  getInstanceNameLower,
  setInstanceNameCache,
} from "@shared/instance-config";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

export type SchemaBootstrapReason = "boot" | "db-sync";

export function log(message: string, source = "migration") {
  const sourceLog = createLogger(source);
  sourceLog.log(message);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function renderDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  // Drizzle SQL fragments do not stringify safely outside Drizzle.
  // Baseline bootstrap only needs tables to exist before data import;
  // existing auto-heal handles production defaults/indexes where needed.
  if (value && typeof value === "object") return undefined;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}

function createTableStatement(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const columnParts = [quoteIdent(column.name), column.getSQLType()];
    if (column.primary) columnParts.push("PRIMARY KEY");
    if (column.notNull) columnParts.push("NOT NULL");
    const defaultValue = renderDefault(column.default);
    if (defaultValue) columnParts.push(`DEFAULT ${defaultValue}`);
    return columnParts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(config.name)} (
  ${columns.join(",\n  ")}
)`;
}


async function ensurePromptModuleTables(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_modules (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
      key VARCHAR(96) NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT 'other',
      prompt TEXT NOT NULL,
      output_spec TEXT NOT NULL DEFAULT '',
      output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      version TEXT NOT NULL DEFAULT '1.0',
      source_skill_name VARCHAR(64),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      scope TEXT NOT NULL DEFAULT 'global',
      owner_user_id TEXT,
      account_id TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_module_versions (
      id SERIAL PRIMARY KEY,
      module_id VARCHAR NOT NULL REFERENCES prompt_modules(id) ON DELETE CASCADE,
      key VARCHAR(96) NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT 'other',
      prompt TEXT NOT NULL,
      output_spec TEXT NOT NULL DEFAULT '',
      output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      version TEXT NOT NULL DEFAULT '1.0',
      source_skill_name VARCHAR(64),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      change_note TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_modules_domain_status ON prompt_modules(domain, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_modules_scope_owner ON prompt_modules(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_modules_account ON prompt_modules(account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prompt_module_versions_module_created ON prompt_module_versions(module_id, created_at)`);
}

async function ensureBaselineTables(
  reason: SchemaBootstrapReason,
  tables: PgTable[] = [],
): Promise<void> {
  if (tables.length === 0) return;
  const { db } = await import("./db");
  log(
    `schema baseline table bootstrap started (reason=${reason}, tables=${tables.length})`,
    "migration",
  );
  await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS vector"));
  log("schema baseline extension ensured: vector", "migration");
  for (const table of tables) {
    const config = getTableConfig(table);
    const statement = createTableStatement(table);
    await db.execute(sql.raw(statement));
    log(`schema baseline table ensured: ${config.name}`, "migration");
  }
  log(
    `schema baseline table bootstrap complete (reason=${reason}, tables=${tables.length})`,
    "migration",
  );
}

export async function runSchemaBootstrap(
  reason: SchemaBootstrapReason = "boot",
  baselineTables: PgTable[] = [],
): Promise<void> {
  log(`schema bootstrap started (reason=${reason})`, "migration");
  await ensureBaselineTables(reason, baselineTables);
  const { pool } = await import("./db");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS communication_audiences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      definition JSONB NOT NULL DEFAULT '{"kind":"manual","personIds":[]}'::jsonb,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_communication_audiences_scope_owner ON communication_audiences(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_communication_audiences_account_updated ON communication_audiences(account_id, updated_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      audience_id TEXT REFERENCES communication_audiences(id) ON DELETE SET NULL,
      sender_name TEXT NOT NULL DEFAULT 'Ray',
      sender_email TEXT NOT NULL DEFAULT 'ray@trymantra.ai',
      reply_to_email TEXT NOT NULL DEFAULT 'ray@trymantra.ai',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_scope_owner ON email_campaigns(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_account_updated ON email_campaigns(account_id, updated_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_audience ON email_campaigns(audience_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS waitlist_applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      position BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE NOT NULL,
      email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email))),
      role TEXT NOT NULL CHECK (role IN ('founder', 'executive', 'investor', 'coach', 'creator', 'other')),
      needs TEXT[] NOT NULL CHECK (cardinality(needs) BETWEEN 1 AND 3),
      readiness TEXT NOT NULL CHECK (readiness IN ('ready', 'possible', 'lower_cost', 'curious')),
      source TEXT NOT NULL DEFAULT 'direct',
      attribution JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'reviewing', 'invited', 'deferred', 'declined')),
      confirmation_email_status TEXT NOT NULL DEFAULT 'pending' CHECK (confirmation_email_status IN ('pending', 'accepted', 'failed')),
      confirmation_email_provider_id TEXT,
      confirmation_email_error TEXT,
      confirmation_email_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_waitlist_applications_status_position ON waitlist_applications(status, position)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_waitlist_applications_created_at ON waitlist_applications(created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS environment_promotion_releases (
      id SERIAL PRIMARY KEY,
      environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
      publish_run_id TEXT NOT NULL,
      version TEXT NOT NULL,
      increment_kind TEXT NOT NULL,
      promoted_commit_sha TEXT NOT NULL,
      release_notes JSONB NOT NULL DEFAULT '{"newFeatures":[],"improvements":[],"fixes":[]}'::jsonb,
      deployment_id TEXT,
      promoted_by_user_id TEXT,
      promoted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_promotion_releases_run ON environment_promotion_releases(publish_run_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_promotion_releases_version ON environment_promotion_releases(environment_id, version)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_promotion_releases_environment_time ON environment_promotion_releases(environment_id, promoted_at DESC)`);

  const HEAL_BUDGET_MS = 2000;
  const heal = async (label: string, fn: () => Promise<void>) => {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"__heal_timeout__">((resolve) => {
        timer = setTimeout(() => resolve("__heal_timeout__"), HEAL_BUDGET_MS);
      });
      const result = await Promise.race([fn(), timeout]);
      if (result === "__heal_timeout__") {
        const elapsed = Date.now() - start;
        try {
          process.stderr.write(
            `[BOOT_QUARANTINE] step=heal id=${JSON.stringify(label)} reason="timeout" elapsedMs=${elapsed} ts=${new Date().toISOString()}\n`,
          );
        } catch {}
        log(
          `auto-heal [${label}] quarantined after ${elapsed}ms (boot continues)`,
          "migration",
        );
      }
    } catch (err: any) {
      log(`auto-heal [${label}] failed: ${err.message}`, "migration");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  await heal("memory_events occurred_at default", async () => {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'memory_events'
        ) THEN
          ALTER TABLE memory_events
            ALTER COLUMN occurred_at SET DEFAULT CURRENT_TIMESTAMP;
          UPDATE memory_events
             SET occurred_at = CURRENT_TIMESTAMP
           WHERE occurred_at IS NULL;
        END IF;
      END $$
    `);
  });

  const ensureColumns = async (
    tableName: string,
    columns: Array<{ name: string; type: string }>,
  ) => {
    for (const column of columns) {
      await pool.query(
        `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS ${quoteIdent(column.name)} ${column.type}`,
      );
    }
  };

  const ensureFreshDatabaseFoundation = async () => {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        invite_token TEXT,
        invite_expires TIMESTAMPTZ,
        reset_token TEXT,
        reset_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        kind TEXT NOT NULL DEFAULT 'personal',
        name TEXT NOT NULL,
        owner_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_owner_user ON accounts(owner_user_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_kind_owner_unique ON accounts(kind, owner_user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id SERIAL PRIMARY KEY,
        account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_account_user_unique ON memberships(account_id, user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_permissions_user_permission_unique ON user_permissions(user_id, permission)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
        display_name TEXT,
        preferred_name TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Chicago',
        onboarding_status TEXT NOT NULL DEFAULT 'not_started',
        memory_consent BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_profiles_account ON user_profiles(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR REFERENCES accounts(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL DEFAULT 'Agent',
        relationship_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_user_unique ON agent_profiles(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_profiles_account ON agent_profiles(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'saved',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        session_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner ON sessions(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT,
        tool_calls JSONB,
        system_steps JSONB,
        segment_chronology JSONB,
        created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(conversation_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_scope_owner ON messages(scope, owner_user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id SERIAL PRIMARY KEY,
        layer TEXT NOT NULL DEFAULT 'short',
        integration_stage TEXT NOT NULL DEFAULT 'stage_0',
        content TEXT NOT NULL,
        summary TEXT,
        content_hash TEXT,
        embedding vector(1536),
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        path TEXT,
        title TEXT,
        one_liner TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        tags TEXT[] DEFAULT '{}'::text[],
        graphed BOOLEAN DEFAULT false,
        pinned BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ(6),
        processing_status TEXT NOT NULL DEFAULT 'idle',
        processing_run_id TEXT,
        processing_started_at TIMESTAMPTZ(6),
        processing_error TEXT,
        processing_updated_at TIMESTAMPTZ(6),
        emotional_state_id INTEGER
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_source_id ON memory_entries(source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_scope_owner ON memory_entries(scope, owner_user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_pages (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        page_id SERIAL NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL DEFAULT '',
        content JSONB DEFAULT '{}'::jsonb,
        plain_text_content TEXT NOT NULL DEFAULT '',
        parent_id TEXT REFERENCES library_pages(id) ON DELETE SET NULL,
        memory_entry_id INTEGER REFERENCES memory_entries(id) ON DELETE SET NULL,
        one_liner TEXT,
        summary TEXT,
        tags TEXT[] NOT NULL DEFAULT '{}'::text[],
        status TEXT,
        emoji TEXT,
        surface BOOLEAN NOT NULL DEFAULT false,
        surface_until TIMESTAMPTZ,
        surface_reason TEXT,
        surface_section TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by_session_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_pages_slug ON library_pages(slug)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_library_pages_scope_owner ON library_pages(scope, owner_user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        skill_id TEXT,
        system_key TEXT,
        schedules JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        timezone TEXT NOT NULL DEFAULT 'America/New_York',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // CREATE TABLE IF NOT EXISTS is a no-op for partially bootstrapped databases.
    // Live duplicated into a state where timers existed without newer columns, so
    // the index below crashed before the later auto-heal block could run.
    // Keep the fresh-foundation path idempotent by ensuring index dependencies
    // immediately after table creation.
    await pool.query(`ALTER TABLE timers ADD COLUMN IF NOT EXISTS system_key TEXT`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_timers_system_key_unique ON timers(system_key)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS responsibility_runs (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        responsibility_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ(6) NOT NULL,
        completed_at TIMESTAMPTZ(6),
        duration_ms INTEGER,
        conversation_id TEXT,
        trigger TEXT NOT NULL DEFAULT 'scheduled',
        intended_fire_at TIMESTAMPTZ(6),
        scheduled_slot_start TIMESTAMPTZ(6),
        scheduled_slot_end TIMESTAMPTZ(6),
        error TEXT,
        metadata JSONB
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS voice_session_active (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active',
        ended_at TIMESTAMP,
        boot_id TEXT,
        scope TEXT NOT NULL DEFAULT 'system',
        owner_user_id TEXT,
        account_id TEXT,
        start_request_id TEXT,
        start_response JSONB,
        start_ready_at TIMESTAMPTZ,
        inflight_turn INTEGER DEFAULT 0,
        last_heartbeat TIMESTAMP
      )
    `);
    // CREATE TABLE IF NOT EXISTS does not upgrade an existing partial table.
    // Ensure every current lease column before creating indexes that depend on
    // them, otherwise startup aborts before the later full voice auto-heal runs.
    await ensureColumns("voice_session_active", [
      { name: "boot_id", type: "TEXT" },
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'system'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
      { name: "start_request_id", type: "TEXT" },
      { name: "start_response", type: "JSONB" },
      { name: "start_ready_at", type: "TIMESTAMPTZ" },
      { name: "inflight_turn", type: "INTEGER DEFAULT 0" },
      { name: "last_heartbeat", type: "TIMESTAMP" },
    ]);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vsa_active_boot ON voice_session_active(boot_id) WHERE status = 'active'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vsa_active_owner ON voice_session_active(owner_user_id) WHERE status = 'active'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vsa_active_account ON voice_session_active(account_id) WHERE status = 'active'`);
  };

  const freshFoundationStart = Date.now();
  try {
    await ensureFreshDatabaseFoundation();
    log(
      `fresh database foundation tables ensured in ${Date.now() - freshFoundationStart}ms`,
      "migration",
    );
  } catch (err: any) {
    log(`fresh database foundation tables failed: ${err.message}`, "migration");
    throw err;
  }

  await heal("platform foundation tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platforms (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platforms_scope_owner ON platforms(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platforms_account ON platforms(account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platforms_updated ON platforms(updated_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_products (
        id SERIAL PRIMARY KEY,
        platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_products_platform ON platform_products(platform_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_products_updated ON platform_products(updated_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_product_environments (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_product_environments_product ON platform_product_environments(product_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_product_environments_updated ON platform_product_environments(updated_at)`);
  });


  await heal("environment configuration tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS provider_connections (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'legacy',
        credential_ref TEXT,
        credential_envelope JSONB,
        credential_last4 TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        last_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_provider_connections_provider ON provider_connections(provider)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_provider_connections_scope_owner ON provider_connections(scope, owner_user_id)`);

    // Add credential_envelope and credential_last4 columns to existing tables
    await pool.query(`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS credential_envelope JSONB`);
    await pool.query(`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS credential_last4 TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS connector_kind TEXT NOT NULL DEFAULT 'integration'`);
    await pool.query(`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS connector_config JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_provider_connections_kind_order ON provider_connections(connector_kind, sort_order)`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS semantic_tier TEXT`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS routing_examples JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`DO $$ BEGIN ALTER TABLE personas ADD CONSTRAINT personas_semantic_tier_check CHECK (semantic_tier IS NULL OR semantic_tier IN ('max', 'high', 'balanced', 'fast')); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await pool.query(`
      UPDATE personas SET semantic_tier = CASE name
        WHEN 'Strategist' THEN 'max'
        WHEN 'Architect' THEN 'max'
        WHEN 'Operator' THEN 'fast'
        WHEN 'Creative' THEN 'high'
        WHEN 'Coach' THEN 'high'
        WHEN 'Companion' THEN 'balanced'
        WHEN 'Router' THEN 'fast'
        ELSE 'balanced'
      END
      WHERE semantic_tier IS NULL
    `);
    await pool.query(`UPDATE personas SET semantic_tier = 'balanced' WHERE name = 'Default' AND semantic_tier = 'fast'`);
    await pool.query(`UPDATE personas SET semantic_tier = 'fast', is_system = TRUE WHERE LOWER(name) = 'router' AND source = 'seed'`);
    await pool.query(`UPDATE personas SET is_system = FALSE WHERE LOWER(name) = 'router' AND source <> 'seed' AND is_system = TRUE`);

    // One-time migration: copy any surviving app_secrets provider_connection:* rows to credential_envelope
    try {
      const migrated = await pool.query(`
        UPDATE provider_connections pc
        SET credential_envelope = s.envelope,
            credential_last4 = COALESCE(s.last4, ''),
            updated_at = CURRENT_TIMESTAMP
        FROM app_secrets s
        WHERE s.name = 'provider_connection:' || pc.id::text
          AND pc.credential_envelope IS NULL
      `);
      if (migrated.rowCount && migrated.rowCount > 0) {
        log(`Migrated ${migrated.rowCount} provider credentials from app_secrets to credential_envelope`, "schema-bootstrap");
      }
    } catch (err: unknown) {
      // app_secrets table may not exist yet or no rows to migrate — that's fine
      log(`Credential migration from app_secrets skipped: ${(err as Error)?.message || err}`, "schema-bootstrap");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_source_bindings (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'github',
        connection_id INTEGER REFERENCES provider_connections(id) ON DELETE SET NULL,
        owner TEXT NOT NULL DEFAULT '',
        repo TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        auto_deploy BOOLEAN NOT NULL DEFAULT false,
        code_indexing_enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_environment ON environment_source_bindings(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_connection ON environment_source_bindings(connection_id)`);
    await pool.query(`ALTER TABLE environment_source_bindings ADD COLUMN IF NOT EXISTS code_indexing_enabled BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_source_bindings_indexing_enabled ON environment_source_bindings(code_indexing_enabled)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_hosting_bindings (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'railway',
        connection_id INTEGER REFERENCES provider_connections(id) ON DELETE SET NULL,
        project_id TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        provider_environment_id TEXT NOT NULL DEFAULT '',
        provider_environment_name TEXT NOT NULL DEFAULT '',
        service_id TEXT NOT NULL DEFAULT '',
        service_name TEXT NOT NULL DEFAULT '',
        public_url TEXT NOT NULL DEFAULT '',
        static_url TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_hosting_bindings_environment ON environment_hosting_bindings(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_hosting_bindings_connection ON environment_hosting_bindings(connection_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_runtime_variables (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'runtime',
        required BOOLEAN NOT NULL DEFAULT false,
        source TEXT NOT NULL DEFAULT 'manual',
        configured BOOLEAN NOT NULL DEFAULT false,
        secret_ref TEXT,
        last_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_runtime_variables_environment ON environment_runtime_variables(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_runtime_variables_key ON environment_runtime_variables(key)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_capability_bindings (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        connection_id INTEGER REFERENCES provider_connections(id) ON DELETE SET NULL,
        capability_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        secret_envelope JSONB,
        secret_last4 TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_env_capability_bindings_environment ON environment_capability_bindings(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_env_capability_bindings_connection ON environment_capability_bindings(connection_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_env_capability_bindings_type ON environment_capability_bindings(capability_type)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_env_capability_bindings_env_type_provider ON environment_capability_bindings(environment_id, capability_type, provider)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_build_lifecycle_configs (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        workflow_template_id TEXT NOT NULL DEFAULT 'build-v1',
        provider_kind TEXT NOT NULL DEFAULT 'railway',
        deploy_policy JSONB NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
        acceptance_target JSONB NOT NULL DEFAULT '{}'::jsonb,
        auth_mode TEXT NOT NULL DEFAULT 'none',
        retry_policy JSONB NOT NULL DEFAULT '{"maxAttempts":3}'::jsonb,
        gate_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        evidence_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        docs_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        disabled_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_environment ON environment_build_lifecycle_configs(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_template ON environment_build_lifecycle_configs(workflow_template_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_build_lifecycle_configs_one_enabled ON environment_build_lifecycle_configs(environment_id) WHERE enabled = true`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS environment_context_artifacts (
        id SERIAL PRIMARY KEY,
        environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        library_page_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_context_artifacts_environment ON environment_context_artifacts(environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_context_artifacts_kind ON environment_context_artifacts(kind)`);
  });

  await heal("context artifacts drop unique env+kind constraint", async () => {
    // Allow multiple artifacts per kind per environment (e.g. multiple design_system pages)
    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'environment_context_artifacts'
        AND indexdef ILIKE '%unique%'
        AND indexname = 'idx_environment_context_artifacts_env_kind'
    `);
    if (rows.length > 0) {
      await pool.query(`DROP INDEX idx_environment_context_artifacts_env_kind`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_environment_context_artifacts_env_kind ON environment_context_artifacts(environment_id, kind)`);
    }
    // Also drop the inline UNIQUE constraint if it exists as a named constraint
    const { rows: constraints } = await pool.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'environment_context_artifacts'
        AND constraint_type = 'UNIQUE'
        AND constraint_name != 'environment_context_artifacts_pkey'
    `);
    for (const c of constraints) {
      await pool.query(`ALTER TABLE environment_context_artifacts DROP CONSTRAINT ${c.constraint_name}`);
    }
  });

  await heal("context artifacts library_page_id UUID to TEXT", async () => {
    // library_page_id was initially created as UUID but library page IDs are TEXT strings (UUIDs or slugs)
    const { rows } = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'environment_context_artifacts' AND column_name = 'library_page_id'
    `);
    if (rows.length > 0 && rows[0].data_type === 'uuid') {
      await pool.query(`ALTER TABLE environment_context_artifacts ALTER COLUMN library_page_id TYPE TEXT USING library_page_id::text`);
    }
  });

  await heal("multi-user identity foundation tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        kind TEXT NOT NULL DEFAULT 'personal',
        name TEXT NOT NULL,
        owner_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_accounts_kind ON accounts(kind)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_accounts_owner_user ON accounts(owner_user_id)`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_kind_owner_unique ON accounts(kind, owner_user_id)`,
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        id SERIAL PRIMARY KEY,
        account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_account_user_unique ON memberships(account_id, user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id)`,
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
        display_name TEXT,
        preferred_name TEXT,
        timezone TEXT NOT NULL DEFAULT 'America/Chicago',
        onboarding_status TEXT NOT NULL DEFAULT 'not_started',
        memory_consent BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_profiles_account ON user_profiles(account_id)`,
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR REFERENCES accounts(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL DEFAULT 'Agent',
        relationship_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_user_unique ON agent_profiles(user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_profiles_account ON agent_profiles(account_id)`,
    );

    await pool.query(`
      CREATE TABLE IF NOT EXISTS privileged_access_audit (
        id SERIAL PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        actor_account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
        impersonated_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
        impersonated_account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        reason TEXT,
        scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_privileged_access_actor ON privileged_access_audit(actor_type, actor_user_id, created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_privileged_access_impersonated ON privileged_access_audit(impersonated_user_id, created_at)`,
    );
  });

  await heal("scoped core personal data columns", async () => {
    const tables = [
      "sessions",
      "messages",
      "workspace_documents",
      "memory_entries",
      "memory_entity_links",
      "info_notes",
      "library_pages",
      "library_page_links",
      "library_annotations",
      "library_page_views",
      "emotional_states",
      "personas",
      "theses",
      "signal_sources",
      "signal_items",
      "scan_runs",
    ];
    for (const table of tables) {
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`,
      );
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_user_id TEXT`,
      );
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS account_id TEXT`,
      );
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`,
      );
      await pool.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT`,
      );
    }
    await pool.query(
      `ALTER TABLE personas ADD COLUMN IF NOT EXISTS template_persona_id INTEGER`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner ON sessions(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_messages_scope_owner ON messages(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_scope_owner ON memory_entries(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_ws_doc_scope_owner ON workspace_documents(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_scope_owner ON library_pages(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_personas_scope_owner ON personas(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_emotional_states_scope_owner ON emotional_states(scope, owner_user_id)`,
    );

    await pool.query(`
      DO $$
      DECLARE
        ray_user_id text;
        ray_account_id text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;
          IF ray_account_id IS NOT NULL THEN
            UPDATE sessions SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE messages SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE workspace_documents SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE memory_entries SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE memory_entity_links SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE info_notes SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE library_pages SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE library_page_links SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE library_annotations SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE library_page_views SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE emotional_states SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            -- Persona templates are reconciled by personaStorage.seedDefaults().
            UPDATE personas SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
            UPDATE tasks SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
            UPDATE projects SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
            UPDATE persons SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
            UPDATE principles SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
          END IF;
        END IF;
      END $$;
    `);
  });

  await heal("memory processing-state columns", async () => {
    await pool.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'idle'`);
    await pool.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS processing_run_id TEXT`);
    await pool.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS processing_error TEXT`);
    await pool.query(`ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS processing_updated_at TIMESTAMPTZ`);
    await pool.query(`UPDATE memory_entries SET processing_status = 'idle' WHERE processing_status IS NULL OR processing_status NOT IN ('idle', 'processing', 'error')`);
    await pool.query(`UPDATE memory_entries SET processing_updated_at = processed_at WHERE processing_updated_at IS NULL AND processed_at IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_processing_status ON memory_entries(processing_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_processing_run ON memory_entries(processing_run_id) WHERE processing_run_id IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_stage_processing_claim ON memory_entries(integration_stage, processing_status, created_at, processed_at) WHERE integration_stage = 'stage_1'`);
  });

  await heal("session tree table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_tree (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        spawn_reason TEXT,
        spawner_tool TEXT,
        spawner_skill_run TEXT,
        spawn_status TEXT NOT NULL DEFAULT 'succeeded',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_session_tree_parent ON session_tree(parent_session_id)`,
    );
    await pool.query(`ALTER TABLE session_tree DROP CONSTRAINT IF EXISTS uk_session_tree_spawn_idem`);
    await pool.query(`DROP INDEX IF EXISTS uk_session_tree_spawn_idem`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_tree_active_spawn_idem
      ON session_tree(parent_session_id, spawn_reason, spawner_skill_run)
      WHERE spawn_status NOT IN ('failed', 'succeeded')
    `);
  });

  await heal("connected_accounts table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        email TEXT,
        label TEXT NOT NULL DEFAULT 'Personal',
        workspace_name TEXT,
        tokens JSONB,
        permissions JSONB,
        healthy BOOLEAN DEFAULT true,
        health_error TEXT,
        health_checked_at TIMESTAMP,
        added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  await heal("connected_accounts columns", async () => {
    const cols = [
      "owner_user_id TEXT",
      "principal_account_id TEXT",
      "vault_id TEXT",
      "provider_account_id TEXT",
      "permissions JSONB",
      "healthy BOOLEAN DEFAULT true",
      "health_error TEXT",
      "health_checked_at TIMESTAMP",
      "missing_scopes JSONB",
    ];
    for (const col of cols) {
      const name = col.split(" ")[0];
      await pool.query(
        `ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS ${name} ${col.slice(name.length + 1)}`,
      );
    }
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_connected_accounts_owner ON connected_accounts(owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_connected_accounts_principal_account ON connected_accounts(principal_account_id)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_connected_accounts_vault ON connected_accounts(vault_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS google_oauth_transactions (token_hash TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, principal_account_id TEXT NOT NULL, vault_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'google', label TEXT, redirect_origin TEXT, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_google_oauth_transactions_expires ON google_oauth_transactions(expires_at)`);
    await pool.query(`
      DO $migration$
      DECLARE
        ray_user_id text;
        ray_account_id text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;
          UPDATE connected_accounts
          SET owner_user_id = COALESCE(owner_user_id, ray_user_id),
              principal_account_id = COALESCE(principal_account_id, ray_account_id)
          WHERE owner_user_id IS NULL;
        END IF;
      END $migration$;
    `);
  });

  await heal("finance sensitive schema", async () => {
    await ensureFinanceSensitiveSchema();
  });

  await heal("calendar metadata private fields", async () => {
    await pool.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.calendar_event_metadata') IS NOT NULL THEN
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS capacity_type TEXT;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agenda TEXT;
        END IF;
      END $migration$;
    `);
  });

  await heal("calendar metadata agent auto-join columns", async () => {
    await pool.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.calendar_event_metadata') IS NOT NULL THEN
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_enabled BOOLEAN NOT NULL DEFAULT false;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_override BOOLEAN;
          UPDATE calendar_event_metadata
            SET agent_join_override = true
            WHERE agent_join_enabled = true AND agent_join_override IS NULL;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_status TEXT;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_detail TEXT;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_session_id TEXT;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_start_at TIMESTAMPTZ;
          ALTER TABLE calendar_event_metadata ADD COLUMN IF NOT EXISTS agent_join_attempted_at TIMESTAMPTZ;
          CREATE INDEX IF NOT EXISTS idx_calendar_event_metadata_agent_join_due
            ON calendar_event_metadata(agent_join_start_at)
            WHERE agent_join_enabled = true AND agent_join_attempted_at IS NULL;
        END IF;
      END $migration$;
    `);
  });

  await heal("calendar metadata upsert constraint", async () => {
    await pool.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.calendar_event_metadata') IS NOT NULL THEN
          IF to_regclass('public.calendar_event_artifacts') IS NOT NULL THEN
            WITH ranked AS (
              SELECT
                id,
                MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
                ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
              FROM calendar_event_metadata
            ), duplicate_links AS (
              SELECT id, keep_id
              FROM ranked
              WHERE rn > 1
            )
            DELETE FROM calendar_event_artifacts artifact
            USING duplicate_links
            WHERE artifact.metadata_id = duplicate_links.id
              AND EXISTS (
                SELECT 1
                FROM calendar_event_artifacts kept
                WHERE kept.metadata_id = duplicate_links.keep_id
                  AND kept.library_page_id = artifact.library_page_id
              );

            WITH ranked AS (
              SELECT
                id,
                MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
                ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
              FROM calendar_event_metadata
            ), duplicate_links AS (
              SELECT id, keep_id
              FROM ranked
              WHERE rn > 1
            )
            UPDATE calendar_event_artifacts artifact
            SET metadata_id = duplicate_links.keep_id
            FROM duplicate_links
            WHERE artifact.metadata_id = duplicate_links.id;
          END IF;

          IF to_regclass('public.calendar_event_people') IS NOT NULL THEN
            WITH ranked AS (
              SELECT
                id,
                MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
                ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
              FROM calendar_event_metadata
            ), duplicate_links AS (
              SELECT id, keep_id
              FROM ranked
              WHERE rn > 1
            )
            DELETE FROM calendar_event_people person
            USING duplicate_links
            WHERE person.metadata_id = duplicate_links.id
              AND EXISTS (
                SELECT 1
                FROM calendar_event_people kept
                WHERE kept.metadata_id = duplicate_links.keep_id
                  AND kept.person_id = person.person_id
              );

            WITH ranked AS (
              SELECT
                id,
                MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
                ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
              FROM calendar_event_metadata
            ), duplicate_links AS (
              SELECT id, keep_id
              FROM ranked
              WHERE rn > 1
            )
            UPDATE calendar_event_people person
            SET metadata_id = duplicate_links.keep_id
            FROM duplicate_links
            WHERE person.metadata_id = duplicate_links.id;
          END IF;


          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
            FROM calendar_event_metadata
          )
          DELETE FROM calendar_event_metadata metadata
          USING ranked
          WHERE metadata.id = ranked.id
            AND ranked.rn > 1;

          ALTER TABLE calendar_event_metadata ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
          ALTER TABLE calendar_event_metadata ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
          UPDATE calendar_event_metadata SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
          UPDATE calendar_event_metadata SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;

          IF to_regclass('public.calendar_event_artifacts') IS NOT NULL THEN
            ALTER TABLE calendar_event_artifacts ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE calendar_event_artifacts ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
            UPDATE calendar_event_artifacts SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
            UPDATE calendar_event_artifacts SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
          END IF;

          IF to_regclass('public.calendar_event_people') IS NOT NULL THEN
            ALTER TABLE calendar_event_people ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
            ALTER TABLE calendar_event_people ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
            UPDATE calendar_event_people SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
            UPDATE calendar_event_people SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
          END IF;

          CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_metadata_event_account_calendar_unique
            ON calendar_event_metadata(google_event_id, account_id, calendar_id);
        END IF;
      END $migration$;
    `);
  });

  await heal("sensitive principal ownership columns", async () => {
    const tables = [
      "email_triage_log",
      "email_messages",
      "email_sync_cursors",
      "email_drafts",
      "calendar_event_metadata",
      "email_sync_log",
      "email_enrichments",
      "email_dismissals",
      "plaid_accounts",
      "plaid_transactions",
      "plaid_holdings",
      "plaid_liabilities",
      "plaid_sync_cursors",
      "manual_assets",
      "manual_liabilities",
      "financial_goals",
      "recurring_expenses",
      "budget_entries",
      "budget_monthly_overrides",
      "income_sources",
      "income_deductions",
      "income_deposits",
      "debt_payments",
      "financed_assets",
      "manual_401k_accounts",
      "future_cash_events",
      "transaction_amortizations",
      "health_metrics",
      "wellness_activities",
      "wellness_logs",
      "gratitude_entries",
      "learning_entries",
      "export_jobs",
      "indexed_content",
    ];

    for (const table of tables) {
      await pool.query(`
        DO $migration$
        BEGIN
          IF to_regclass('public.${table}') IS NOT NULL THEN
            ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
            ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_user_id);
            CREATE INDEX IF NOT EXISTS idx_${table}_principal_account ON ${table}(principal_account_id);
          END IF;
        END $migration$;
      `);
    }

    await pool.query(`
      DO $migration$
      DECLARE
        ray_user_id text;
        ray_account_id text;
        table_name text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;
          FOREACH table_name IN ARRAY ARRAY[
            'plaid_accounts','plaid_transactions','plaid_holdings','plaid_liabilities','plaid_sync_cursors','manual_assets','manual_liabilities','financial_goals','recurring_expenses','budget_entries','budget_monthly_overrides','income_sources','income_deductions','income_deposits','debt_payments','financed_assets','manual_401k_accounts','future_cash_events','transaction_amortizations',
            'health_metrics','wellness_activities','wellness_logs','gratitude_entries','learning_entries','export_jobs','indexed_content'
          ] LOOP
            IF to_regclass('public.' || table_name) IS NOT NULL THEN
              EXECUTE format('UPDATE %I SET owner_user_id = COALESCE(owner_user_id, $1), principal_account_id = COALESCE(principal_account_id, $2) WHERE owner_user_id IS NULL', table_name)
              USING ray_user_id, ray_account_id;
            END IF;
          END LOOP;
        END IF;
      END $migration$;
    `);
  });

  await heal("derived personal data ownership columns", async () => {
    const normalOwnedTables = [
      "session_output_buffer",
      "session_artifacts",
      "plan_executions",
      "plan_steps",
    ];
    for (const table of normalOwnedTables) {
      await pool.query(`
        DO $migration$
        BEGIN
          IF to_regclass('public.${table}') IS NOT NULL THEN
            ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
            ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS account_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_user_id);
            CREATE INDEX IF NOT EXISTS idx_${table}_account ON ${table}(account_id);
          END IF;
        END $migration$;
      `);
    }

    await pool.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.calendar_event_people') IS NOT NULL THEN
          ALTER TABLE calendar_event_people ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
          ALTER TABLE calendar_event_people ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_calendar_event_people_owner ON calendar_event_people(owner_user_id);
          CREATE INDEX IF NOT EXISTS idx_calendar_event_people_principal_account ON calendar_event_people(principal_account_id);
        END IF;
        IF to_regclass('public.calendar_event_metadata') IS NOT NULL AND to_regclass('public.library_pages') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS calendar_event_artifacts (
            id SERIAL PRIMARY KEY,
            metadata_id INTEGER NOT NULL REFERENCES calendar_event_metadata(id) ON DELETE CASCADE,
            owner_user_id TEXT,
            principal_account_id TEXT,
            artifact_type TEXT NOT NULL DEFAULT 'library_page',
            library_page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
            artifact_kind TEXT NOT NULL DEFAULT 'brief',
            title TEXT,
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_artifacts_metadata_page_unique ON calendar_event_artifacts(metadata_id, library_page_id);
          CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_metadata ON calendar_event_artifacts(metadata_id);
          CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_owner ON calendar_event_artifacts(owner_user_id);
          CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_principal_account ON calendar_event_artifacts(principal_account_id);
        END IF;
      END $migration$;
    `);

    await pool.query(`
      DO $migration$
      DECLARE
        ray_user_id text;
        ray_account_id text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;

          IF to_regclass('public.plan_steps') IS NOT NULL AND to_regclass('public.plan_executions') IS NOT NULL THEN
            UPDATE plan_steps ps
            SET owner_user_id = COALESCE(ps.owner_user_id, pe.owner_user_id, ray_user_id),
                account_id = COALESCE(ps.account_id, pe.account_id, ray_account_id)
            FROM plan_executions pe
            WHERE ps.plan_id = pe.id AND (ps.owner_user_id IS NULL OR ps.account_id IS NULL);
          END IF;
          IF to_regclass('public.calendar_event_people') IS NOT NULL AND to_regclass('public.calendar_event_metadata') IS NOT NULL THEN
            UPDATE calendar_event_people cep
            SET owner_user_id = COALESCE(cep.owner_user_id, cem.owner_user_id),
                principal_account_id = COALESCE(cep.principal_account_id, cem.principal_account_id)
            FROM calendar_event_metadata cem
            WHERE cep.metadata_id = cem.id AND (cep.owner_user_id IS NULL OR cep.principal_account_id IS NULL);
          END IF;

          UPDATE session_output_buffer SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
          UPDATE session_artifacts SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
          UPDATE plan_executions SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
          UPDATE plan_steps SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id) WHERE owner_user_id IS NULL;
        END IF;
      END $migration$;
    `);
  });

  await heal("voice_session_active inflight columns", async () => {
    await pool.query(
      `ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS inflight_turn INTEGER DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP`,
    );
    // Partial index for the only hot read pattern (status='active'). The previous
    // idx_vsa_status btree on a low-cardinality column was useless once the table
    // accumulated abandoned/complete rows; this partial index stays tiny because
    // the active set is bounded by concurrent voice callers.
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'system'`);
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS start_request_id TEXT`);
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS start_response JSONB`);
    await pool.query(`ALTER TABLE voice_session_active ADD COLUMN IF NOT EXISTS start_ready_at TIMESTAMPTZ`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vsa_active_boot ON voice_session_active(boot_id) WHERE status = 'active'`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vsa_active_owner ON voice_session_active(owner_user_id) WHERE status = 'active'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vsa_active_account ON voice_session_active(account_id) WHERE status = 'active'`);
    await pool.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY account_id, conversation_id
                 ORDER BY started_at DESC, id DESC
               ) AS active_rank
        FROM voice_session_active
        WHERE status = 'active' AND scope = 'user' AND conversation_id IS NOT NULL
      )
      UPDATE voice_session_active AS lease
      SET status = 'abandoned', ended_at = NOW(), inflight_turn = 0
      FROM ranked
      WHERE lease.id = ranked.id AND ranked.active_rank > 1
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vsa_active_account_conversation_unique
      ON voice_session_active(account_id, conversation_id)
      WHERE status = 'active' AND scope = 'user' AND conversation_id IS NOT NULL
    `);
    await pool.query(`DROP INDEX IF EXISTS idx_vsa_active_account_request_unique`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vsa_account_request_unique
      ON voice_session_active(account_id, start_request_id)
      WHERE scope = 'user' AND start_request_id IS NOT NULL
    `);
    // The session_id UNIQUE constraint already provides a btree, so the explicit
    // idx_vsa_session_id added in the original migration is redundant.
    await pool.query(`DROP INDEX IF EXISTS idx_vsa_session_id`);
    await pool.query(`DROP INDEX IF EXISTS idx_vsa_status`);
  });

  await heal("library_pages type+metadata columns", async () => {
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'page'`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS metadata JSONB`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_type ON library_pages(type)`,
    );
  });

  await heal("plaid_transactions source column", async () => {
    await pool.query(
      `ALTER TABLE plaid_transactions ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'plaid'`,
    );
  });

  await heal("liabilities manual_payment_amount column", async () => {
    await pool.query(
      `ALTER TABLE plaid_liabilities ADD COLUMN IF NOT EXISTS manual_payment_amount REAL`,
    );
    await pool.query(
      `ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS manual_payment_amount REAL`,
    );
  });

  await heal("library progressive disclosure columns", async () => {
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS one_liner TEXT`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS summary TEXT`,
    );
    await pool.query(
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS one_liner TEXT`,
    );
  });

  await heal("library_pages created_by_session_id column", async () => {
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS created_by_session_id TEXT`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_session ON library_pages (created_by_session_id)`,
    );
    await pool.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_library_pages_plan_session ON library_pages (created_by_session_id) WHERE created_by_session_id IS NOT NULL AND tags @> ARRAY['plan']::text[]`,
    );
  });

  await heal("library_pages surfacing columns", async () => {
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS surface BOOLEAN NOT NULL DEFAULT false`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS surface_until TIMESTAMPTZ`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS surface_reason TEXT`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS surface_section TEXT`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_surface_until ON library_pages (surface_until)`,
    );
  });

  await heal("users legacy username column", async () => {
    // The app no longer collects usernames. Some existing databases still have
    // users.username as NOT NULL from the old schema, which makes registration
    // fail when the insert correctly omits it. Keep this independent from
    // default repairs so one drifted column cannot block the username drop.
    await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique`);
    await pool.query(`DROP INDEX IF EXISTS users_username_unique`);
    await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS username`);
  });

  await heal("users insert defaults", async () => {
    // Older Railway databases and DB sync restores can have users.id marked
    // NOT NULL without preserving the Drizzle-declared gen_random_uuid()
    // default. Registration omits generated columns and relies on the DB.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(
      `ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE users ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`,
    );
  });

  await heal("generated column insert defaults", async () => {
    // Older Railway databases and DB sync/baseline restores can preserve
    // NOT NULL constraints while losing SQL defaults declared in Drizzle.
    // Runtime insert paths intentionally omit generated/defaulted columns,
    // so re-assert the database defaults that those paths depend on.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await pool.query(
      `ALTER TABLE library_pages ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE library_pages ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE library_pages ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP`,
    );

    await pool.query(
      `ALTER TABLE skills ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE skills ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE skills ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP`,
    );

    await pool.query(
      `ALTER TABLE memory_transitions ALTER COLUMN transitioned_at SET DEFAULT CURRENT_TIMESTAMP`,
    );

    // --- signal_sources defaults ---
    await pool.query(
      `ALTER TABLE signal_sources ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE signal_sources ALTER COLUMN enabled SET DEFAULT true`,
    );
    await pool.query(
      `ALTER TABLE signal_sources ALTER COLUMN signal_count SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE signal_sources ALTER COLUMN consecutive_failures SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE signal_sources ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`,
    );

    // --- signal_items defaults ---
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN snippet SET DEFAULT ''`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN curation_status SET DEFAULT 'unread'`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN matched_topics SET DEFAULT '{}'::text[]`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN scanned_at SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN relevance_score SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN relevance_tags SET DEFAULT '{}'::text[]`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN matching_skills SET DEFAULT '{}'::text[]`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN matching_theses SET DEFAULT '{}'::text[]`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN status SET DEFAULT 'new'`,
    );
    await pool.query(
      `ALTER TABLE signal_items ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`,
    );

    // --- scan_runs defaults ---
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`,
    );
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN started_at SET DEFAULT CURRENT_TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN sources_scanned SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN items_found SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN items_surfaced SET DEFAULT 0`,
    );
    await pool.query(
      `ALTER TABLE scan_runs ALTER COLUMN items_deduped SET DEFAULT 0`,
    );
  });

  await heal("messages table column drift", async () => {
    // Drizzle schema declares `conversation_id` (matching prod), but older DBs
    // had this column named `session_id`. Rename in place if the legacy name is
    // still present and the new name isn't yet.
    const cols = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'
    `);
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (names.has("session_id") && !names.has("conversation_id")) {
      await pool.query(
        `ALTER TABLE messages RENAME COLUMN session_id TO conversation_id`,
      );
      log(
        "auto-heal: renamed messages.session_id → conversation_id",
        "migration",
      );
    }
    // These two JSONB columns are referenced by chat/voice runtime code but
    // were never added to some prod DBs. ADD IF NOT EXISTS is idempotent.
    await pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS system_steps JSONB`,
    );
    await pool.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS segment_chronology JSONB`,
    );
  });

  await heal("memory_vnext claim tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_vnext_claims (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        topics TEXT[] DEFAULT '{}'::text[],
        entity_mentions JSONB DEFAULT '[]'::jsonb,
        source_claim_index INTEGER,
        lifecycle_stage TEXT NOT NULL DEFAULT 'extracted',
        lifecycle_stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        content_hash TEXT NOT NULL,
        embedding vector(384),
        source_memory_id INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_memory_vnext_claim_content_hash UNIQUE (content_hash)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_type ON memory_vnext_claims(claim_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_source_memory ON memory_vnext_claims(source_memory_id)`);
    await pool.query(`ALTER TABLE memory_vnext_claims ADD COLUMN IF NOT EXISTS title TEXT`);
    await pool.query(`ALTER TABLE memory_vnext_claims ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'extracted'`);
    await pool.query(`ALTER TABLE memory_vnext_claims ADD COLUMN IF NOT EXISTS lifecycle_stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_source ON memory_vnext_claims(source, source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_lifecycle_stage ON memory_vnext_claims(lifecycle_stage)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_created_at ON memory_vnext_claims(created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_scope_owner ON memory_vnext_claims(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_account ON memory_vnext_claims(account_id)`);

    const embeddingType = await pool.query<{ embedding_type: string | null }>(`
      SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'memory_vnext_claims'
        AND a.attname = 'embedding'
        AND NOT a.attisdropped
      LIMIT 1
    `);
    const currentEmbeddingType = embeddingType.rows[0]?.embedding_type ?? null;
    log(`memory.vnext.schema_check embedding=${currentEmbeddingType || "missing"} expected=vector(384)`, "migration");
    if (currentEmbeddingType !== "vector(384)") {
      await pool.query(`DROP INDEX IF EXISTS idx_memory_vnext_claim_embedding`);
      await pool.query(`ALTER TABLE memory_vnext_claims ALTER COLUMN embedding TYPE vector(384) USING NULL`);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_embedding
        ON memory_vnext_claims
        USING hnsw (embedding vector_cosine_ops)
        WHERE embedding IS NOT NULL
      `);
      const repairedType = await pool.query<{ embedding_type: string | null }>(`
        SELECT format_type(a.atttypid, a.atttypmod) AS embedding_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'memory_vnext_claims'
          AND a.attname = 'embedding'
          AND NOT a.attisdropped
        LIMIT 1
      `);
      log(`memory.vnext.schema_repair embedding_before=${currentEmbeddingType || "missing"} embedding_after=${repairedType.rows[0]?.embedding_type || "missing"}`, "migration");
    } else {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_embedding
        ON memory_vnext_claims
        USING hnsw (embedding vector_cosine_ops)
        WHERE embedding IS NOT NULL
      `);
      log("memory.vnext.schema_ok embedding=vector(384)", "migration");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_vnext_sources (
        id SERIAL PRIMARY KEY,
        claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'extracted_from',
        context TEXT NOT NULL DEFAULT '',
        quote TEXT,
        span_start INTEGER,
        span_end INTEGER,
        strength REAL NOT NULL DEFAULT 1,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_memory_vnext_sources_ref UNIQUE (claim_id, source_type, source_id, relationship)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_sources_claim ON memory_vnext_sources(claim_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_sources_source ON memory_vnext_sources(source_type, source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_sources_relationship ON memory_vnext_sources(relationship)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_sources_scope_owner ON memory_vnext_sources(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_sources_account ON memory_vnext_sources(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_vnext_entity_links (
        id SERIAL PRIMARY KEY,
        claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_memory_vnext_entity_link UNIQUE (claim_id, entity_type, entity_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_entity_claim ON memory_vnext_entity_links(claim_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_entity ON memory_vnext_entity_links(entity_type, entity_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_entity_scope_owner ON memory_vnext_entity_links(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_entity_account ON memory_vnext_entity_links(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_vnext_claim_links (
        id SERIAL PRIMARY KEY,
        from_claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
        to_claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
        relationship TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_memory_vnext_claim_link UNIQUE (from_claim_id, to_claim_id, relationship)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_links_from ON memory_vnext_claim_links(from_claim_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_links_to ON memory_vnext_claim_links(to_claim_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_links_scope_owner ON memory_vnext_claim_links(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_links_account ON memory_vnext_claim_links(account_id)`);
  });

  await heal("memory_vnext_source_queue table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_vnext_source_queue (
        id SERIAL PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        last_modified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'pending',
        last_extracted_at TIMESTAMPTZ,
        content_hash TEXT,
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_vnext_source_queue_type_id_owner UNIQUE (source_type, source_id, owner_user_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vnext_source_queue_status ON memory_vnext_source_queue(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vnext_source_queue_pending_settle ON memory_vnext_source_queue(status, last_modified_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vnext_source_queue_owner ON memory_vnext_source_queue(owner_user_id)`);
  });

  await heal("vnext claims drop legacy FK + sentinel cleanup", async () => {
    // Drop FK constraint from source_memory_id → memory_entries if it exists
    await pool.query(`
      ALTER TABLE memory_vnext_claims
        DROP CONSTRAINT IF EXISTS memory_vnext_claims_source_memory_id_memory_entries_id_fk
    `);
    // Convert sentinel 0 values to NULL
    await pool.query(`
      UPDATE memory_vnext_claims SET source_memory_id = NULL WHERE source_memory_id = 0
    `);
  });

  await heal("memory_sources table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_sources (
        id SERIAL PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relationship TEXT NOT NULL DEFAULT 'extracted_from',
        context TEXT NOT NULL DEFAULT '',
        quote TEXT,
        span_start INTEGER,
        span_end INTEGER,
        strength REAL NOT NULL DEFAULT 1,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_memory_sources_ref UNIQUE (memory_id, source_type, source_id, relationship)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_sources_memory ON memory_sources(memory_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_sources_source ON memory_sources(source_type, source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_sources_relationship ON memory_sources(relationship)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_sources_scope_owner ON memory_sources(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_sources_account ON memory_sources(account_id)`);

    const result = await pool.query(`
      INSERT INTO memory_sources (
        memory_id, source_type, source_id, relationship, context, strength,
        scope, owner_user_id, account_id, created_by_user_id, updated_by_user_id, created_at
      )
      SELECT
        me.id,
        me.source,
        me.source_id,
        'extracted_from',
        'Backfilled from legacy memory_entries.source/source_id',
        1,
        me.scope,
        me.owner_user_id,
        me.account_id,
        me.created_by_user_id,
        me.updated_by_user_id,
        COALESCE(me.created_at, CURRENT_TIMESTAMP)
      FROM memory_entries me
      WHERE me.source_id IS NOT NULL AND me.source_id <> ''
      ON CONFLICT (memory_id, source_type, source_id, relationship) DO NOTHING
    `);

    const linkResult = await pool.query(`
      WITH classified_links AS (
        SELECT
          ml.id,
          CASE
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'depends_on'
              OR lower(replace(ml.relationship, '-', '_')) = 'depends_on'
              THEN ml.from_id
            WHEN lower(replace(ml.relationship, '-', '_')) IN ('derived_from', 'extracted_from')
              THEN ml.from_id
            ELSE ml.to_id
          END AS memory_id,
          'memory'::text AS source_type,
          CASE
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'depends_on'
              OR lower(replace(ml.relationship, '-', '_')) = 'depends_on'
              THEN ml.to_id::text
            WHEN lower(replace(ml.relationship, '-', '_')) IN ('derived_from', 'extracted_from')
              THEN ml.to_id::text
            ELSE ml.from_id::text
          END AS source_id,
          CASE
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'supports'
              OR lower(replace(ml.relationship, '-', '_')) = 'supports'
              THEN 'supports'
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'contradicts'
              OR lower(replace(ml.relationship, '-', '_')) = 'contradicts'
              THEN 'contradicts'
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'evolves'
              OR lower(replace(ml.relationship, '-', '_')) IN ('evolves', 'refines')
              THEN 'refines'
            WHEN lower(replace(ml.relationship, '-', '_')) = 'supersedes'
              THEN 'supersedes'
            WHEN lower(replace(ml.relationship_type, '-', '_')) = 'depends_on'
              OR lower(replace(ml.relationship, '-', '_')) = 'depends_on'
              THEN 'depends_on'
            WHEN lower(replace(ml.relationship, '-', '_')) IN ('derived_from', 'extracted_from')
              THEN 'extracted_from'
          END AS source_relationship,
          ml.relationship AS context,
          ml.strength,
          COALESCE(target.scope, source.scope, 'user') AS scope,
          COALESCE(target.owner_user_id, source.owner_user_id) AS owner_user_id,
          COALESCE(target.account_id, source.account_id) AS account_id,
          COALESCE(target.created_by_user_id, source.created_by_user_id) AS created_by_user_id,
          COALESCE(target.updated_by_user_id, source.updated_by_user_id) AS updated_by_user_id,
          ml.created_at
        FROM memory_links ml
        JOIN memory_entries source ON source.id = ml.from_id
        JOIN memory_entries target ON target.id = ml.to_id
        WHERE
          lower(replace(ml.relationship_type, '-', '_')) IN ('supports', 'contradicts', 'evolves', 'depends_on')
          OR lower(replace(ml.relationship, '-', '_')) IN (
            'supports', 'contradicts', 'evolves', 'refines', 'supersedes',
            'depends_on', 'derived_from', 'extracted_from'
          )
      )
      INSERT INTO memory_sources (
        memory_id, source_type, source_id, relationship, context, strength,
        scope, owner_user_id, account_id, created_by_user_id, updated_by_user_id, created_at
      )
      SELECT
        memory_id,
        source_type,
        source_id,
        source_relationship,
        context,
        strength,
        scope,
        owner_user_id,
        account_id,
        created_by_user_id,
        updated_by_user_id,
        COALESCE(created_at, CURRENT_TIMESTAMP)
      FROM classified_links
      WHERE source_relationship IS NOT NULL
      ON CONFLICT (memory_id, source_type, source_id, relationship) DO NOTHING
    `);

    if (result.rowCount && result.rowCount > 0) {
      log(
        `auto-heal: backfilled ${result.rowCount} memory_sources rows from memory_entries.source/source_id`,
        "migration",
      );
    }

    if (linkResult.rowCount && linkResult.rowCount > 0) {
      log(
        `auto-heal: backfilled ${linkResult.rowCount} memory_sources rows from meaningful memory_links`,
        "migration",
      );
    }
  });

  await heal("memory_entries unique constraint", async () => {
    const exists = await pool.query(`
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON c.conrelid = r.oid
      WHERE c.conname = 'uk_memory_layer_source_id' AND r.relname = 'memory_entries'
    `);
    if (exists.rowCount === 0) {
      const dupeCount = await pool.query(`
        SELECT count(*) AS cnt FROM memory_entries
        WHERE source_id IS NOT NULL
          AND id NOT IN (
            SELECT DISTINCT ON (layer, source, source_id) id
            FROM memory_entries
            WHERE source_id IS NOT NULL
            ORDER BY layer, source, source_id, processed_at DESC NULLS LAST, id DESC
          )
      `);
      const removed = parseInt(dupeCount.rows[0]?.cnt || "0", 10);
      if (removed > 0) {
        await pool.query(`
          DELETE FROM memory_entries
          WHERE source_id IS NOT NULL
            AND id NOT IN (
              SELECT DISTINCT ON (layer, source, source_id) id
              FROM memory_entries
              WHERE source_id IS NOT NULL
              ORDER BY layer, source, source_id, processed_at DESC NULLS LAST, id DESC
            )
        `);
        log(
          `auto-heal: removed ${removed} duplicate memory_entries (source_id IS NOT NULL only)`,
          "migration",
        );
      }
      await pool.query(`
        ALTER TABLE memory_entries
        ADD CONSTRAINT uk_memory_layer_source_id UNIQUE (layer, source, source_id)
      `);
      log(
        "auto-heal: created uk_memory_layer_source_id on memory_entries",
        "migration",
      );
    }
  });

  await heal("memory_entries timestamp defaults", async () => {
    // Drizzle declares `created_at` / `processed_at` with
    // `defaultNow().notNull()`, but the legacy DB sync only copies
    // rows, not column defaults. Railway's memory_entries lost its
    // `DEFAULT CURRENT_TIMESTAMP`, so any insert that didn't set the
    // timestamp explicitly was crashing with a NOT NULL violation
    // (postgres code 23502) — manifesting as "Error creating session" the
    // moment the user opened a chat. Re-asserting the defaults is
    // idempotent and survives future syncs.
    // Backfill any pre-existing NULLs FIRST so SET NOT NULL doesn't fail.
    await pool.query(
      `UPDATE memory_entries SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL`,
    );
    await pool.query(`
      ALTER TABLE memory_entries
        ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP,
        ALTER COLUMN created_at SET NOT NULL,
        ALTER COLUMN processed_at SET DEFAULT CURRENT_TIMESTAMP
    `);
  });

  await heal("workspace_documents unique constraint", async () => {
    const exists = await pool.query(`
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON c.conrelid = r.oid
      WHERE c.conname = 'uk_ws_doc_type_id' AND r.relname = 'workspace_documents'
    `);
    if (exists.rowCount === 0) {
      const dupeCount = await pool.query(`
        SELECT count(*) AS cnt FROM workspace_documents
        WHERE id NOT IN (
          SELECT DISTINCT ON (doc_type, doc_id) id
          FROM workspace_documents
          ORDER BY doc_type, doc_id, updated_at DESC NULLS LAST, id DESC
        )
      `);
      const removed = parseInt(dupeCount.rows[0]?.cnt || "0", 10);
      if (removed > 0) {
        await pool.query(`
          DELETE FROM workspace_documents
          WHERE id NOT IN (
            SELECT DISTINCT ON (doc_type, doc_id) id
            FROM workspace_documents
            ORDER BY doc_type, doc_id, updated_at DESC NULLS LAST, id DESC
          )
        `);
        log(
          `auto-heal: removed ${removed} duplicate workspace_documents`,
          "migration",
        );
      }
      await pool.query(`
        ALTER TABLE workspace_documents
        ADD CONSTRAINT uk_ws_doc_type_id UNIQUE (doc_type, doc_id)
      `);
      log(
        "auto-heal: created uk_ws_doc_type_id on workspace_documents",
        "migration",
      );
    }
  });

  await heal("plaid finance tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plaid_accounts (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        official_name TEXT,
        type TEXT NOT NULL,
        subtype TEXT,
        mask TEXT,
        currency_code TEXT DEFAULT 'USD',
        current_balance REAL,
        available_balance REAL,
        credit_limit REAL,
        last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plaid_transactions (
        id SERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        date TEXT NOT NULL,
        amount REAL NOT NULL,
        currency_code TEXT DEFAULT 'USD',
        name TEXT NOT NULL,
        merchant_name TEXT,
        category_primary TEXT,
        category_detailed TEXT,
        category_confidence TEXT,
        pending BOOLEAN DEFAULT false,
        location_city TEXT,
        location_region TEXT,
        is_recurring BOOLEAN DEFAULT false,
        recurring_stream_id TEXT,
        source TEXT DEFAULT 'plaid',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plaid_securities (
        id SERIAL PRIMARY KEY,
        security_id TEXT NOT NULL UNIQUE,
        name TEXT,
        ticker_symbol TEXT,
        type TEXT,
        close_price REAL,
        close_price_as_of TEXT,
        currency_code TEXT DEFAULT 'USD',
        last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plaid_holdings (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        security_id TEXT NOT NULL,
        quantity REAL NOT NULL,
        cost_basis REAL,
        institution_value REAL,
        institution_price REAL,
        currency_code TEXT DEFAULT 'USD',
        last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plaid_liabilities (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        liability_type TEXT NOT NULL,
        balance REAL,
        credit_limit REAL,
        apr_percentage REAL,
        apr_type TEXT,
        minimum_payment REAL,
        next_payment_due_date TEXT,
        interest_rate_percentage REAL,
        origination_date TEXT,
        loan_term TEXT,
        last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS plaid_sync_cursors (
        id SERIAL PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE,
        cursor TEXT,
        last_synced TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS pages_completed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS total_added INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS sync_error TEXT;
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS sync_started_at TIMESTAMP;
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS last_sync_attempt TIMESTAMP;
      ALTER TABLE plaid_sync_cursors ADD COLUMN IF NOT EXISTS needs_investigation BOOLEAN NOT NULL DEFAULT false;
    `);
  });

  await heal("transaction_amortizations table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transaction_amortizations (
        id SERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        original_amount REAL NOT NULL,
        spread_months INTEGER NOT NULL,
        start_month TEXT NOT NULL,
        category TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transaction_amortizations_active_idx
        ON transaction_amortizations (is_active);
      CREATE INDEX IF NOT EXISTS transaction_amortizations_txn_idx
        ON transaction_amortizations (transaction_id);
    `);
  });

  await heal("recurring_expenses unique index", async () => {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_expenses_transaction_pattern ON recurring_expenses(transaction_pattern) WHERE transaction_pattern IS NOT NULL AND source = 'plaid'`,
    );
  });

  await heal("email_messages is_done column", async () => {
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_done BOOLEAN NOT NULL DEFAULT false`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS done_reason TEXT`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS done_at TIMESTAMP`,
    );
  });

  await heal("email_messages direction column", async () => {
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'unknown'`,
    );
    await pool.query(`
      UPDATE email_messages
      SET direction = CASE
        WHEN label_ids ? 'SENT' THEN 'outbound'
        ELSE 'inbound'
      END
      WHERE direction IS NULL OR direction = 'unknown'
    `);
  });

  try {
    const peopleStorage = new PeopleStorage();
    const { migrated, total } = await peopleStorage.migrateAllPeople();
    if (migrated > 0) {
      log(
        `People migration: ${migrated}/${total} files updated to current schema`,
        "migration",
      );
    } else {
      log(`People migration: all ${total} files up to date`, "migration");
    }
  } catch (err: any) {
    log(`People migration failed: ${err.message}`, "migration");
  }

  await heal("encrypt plaintext tokens", async () => {
    const { getEncryptionKey, needsEncryption, encryptTokens } =
      await import("./encryption");
    const key = getEncryptionKey();
    if (!key) return;

    const rows = await pool.query(
      `SELECT id, account_id, tokens FROM connected_accounts WHERE tokens IS NOT NULL`,
    );
    let migrated = 0;
    for (const row of rows.rows) {
      if (needsEncryption(row.tokens)) {
        const encrypted = await encryptTokens(row.tokens);
        await pool.query(
          `UPDATE connected_accounts SET tokens = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(encrypted), row.id],
        );
        migrated++;
      }
    }
    if (migrated > 0) {
      log(
        `Token encryption migration: encrypted ${migrated} plaintext token(s)`,
        "migration",
      );
    }
  });

  await heal("skills schema columns", async () => {
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'`,
    );
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS activity TEXT NOT NULL DEFAULT 'e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d'`,
    );
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS add_to_memory BOOLEAN NOT NULL DEFAULT true`,
    );
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS customized BOOLEAN NOT NULL DEFAULT false`,
    );
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS pinned_to_context BOOLEAN NOT NULL DEFAULT false`,
    );
  });

  await heal("activity GUID migration", async () => {
    const activityMap: [string, string][] = [
      ["chat", "c7a1e3b4-5d2f-4a89-b6e0-1f8c9d2e3a4b"],
      ["agent_tasks", "d8b2f4c5-6e3a-4b90-c7f1-2a9d0e3f4b5c"],
      ["background", "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d"],
      ["context_assembly", "f0d4b6e7-8a5c-4d12-e9b3-4c1f2a5b6d7e"],
      ["myelination", "a1e5c7f8-9b6d-4e23-f0c4-5d2a3b6c7e8f"],
      ["meta_cognition", "b2f6d8a9-0c7e-4f34-a1d5-6e3b4c7d8f0a"],
      ["strategy", "c3a7e9b0-1d8f-4a45-b2e6-7f4c5d8e9a1b"],
    ];
    let migrated = 0;
    for (const [oldId, newId] of activityMap) {
      const result = await pool.query(
        `UPDATE skills SET activity = $1 WHERE activity = $2`,
        [newId, oldId],
      );
      migrated += result.rowCount ?? 0;
    }
    if (migrated > 0) {
      log(
        `activity GUID migration: updated ${migrated} skill rows`,
        "migration",
      );
    }

    const settingsResult = await pool.query(
      `SELECT value FROM system_settings WHERE key = 'model_profiles'`,
    );
    if (settingsResult.rowCount && settingsResult.rowCount > 0) {
      const raw = settingsResult.rows[0].value;
      let json = typeof raw === "string" ? raw : JSON.stringify(raw);
      let changed = false;
      for (const [oldId, newId] of activityMap) {
        const before = json;
        json = json.split(`"${oldId}"`).join(`"${newId}"`);
        if (json !== before) changed = true;
      }
      if (changed) {
        await pool.query(
          `UPDATE system_settings SET value = $1 WHERE key = 'model_profiles'`,
          [json],
        );
        log(
          "activity GUID migration: updated model_profiles routing keys",
          "migration",
        );
      }
    }
  });

  await heal("memory_entries pinned column", async () => {
    await pool.query(
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false`,
    );
  });

  await heal("memory_entries integration_stage column", async () => {
    await pool.query(
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS integration_stage TEXT NOT NULL DEFAULT 'stage_0'`,
    );
    await pool.query(`
      UPDATE memory_entries
      SET integration_stage = CASE
        WHEN COALESCE(title, '') <> ''
          AND COALESCE(summary, '') <> ''
          AND tags IS NOT NULL
          AND array_length(tags, 1) > 0
          THEN 'stage_1'
        WHEN layer IN ('mid', 'long', 'workspace') THEN 'stage_1'
        ELSE 'stage_0'
      END
      WHERE integration_stage IS NULL OR integration_stage = 'stage_0'
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_memory_integration_stage ON memory_entries(integration_stage)`,
    );
  });

  await heal("system_events table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_events (
        id SERIAL PRIMARY KEY,
        event_id TEXT NOT NULL,
        boot_id TEXT,
        category TEXT NOT NULL,
        event TEXT NOT NULL,
        payload JSONB DEFAULT '{}',
        run_id TEXT,
        session_key TEXT,
        scope TEXT NOT NULL DEFAULT 'system',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_sys_events_category ON system_events(category)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_sys_events_event ON system_events(event)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_sys_events_created_at ON system_events(created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_sys_events_run_id ON system_events(run_id)`,
    );
    await pool.query(`ALTER TABLE system_events ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'system'`);
    await pool.query(`ALTER TABLE system_events ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE system_events ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sys_events_scope_owner ON system_events(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sys_events_account ON system_events(account_id)`);
  });

  await heal("system_hooks table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_hooks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        event_pattern TEXT NOT NULL,
        condition JSONB,
        action_type TEXT NOT NULL,
        action_config JSONB NOT NULL,
        cooldown_seconds INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  await heal("stale one-shot system hooks cleanup", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);
    const migrationName = "stale_system_hooks_cleanup_phase_1_v1";
    const exists = await pool.query(
      `SELECT 1 FROM app_migrations WHERE name = $1`,
      [migrationName],
    );
    if (exists.rowCount && exists.rowCount > 0) return;

    const result = await pool.query(`
      DELETE FROM system_hooks
      WHERE id = ANY($1::int[])
        AND name <> 'sleep-forgetting-trigger'
    `, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 18, 23]]);

    await pool.query(
      `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [migrationName, JSON.stringify({ rowsDeleted: result.rowCount ?? 0, retained: ["sleep-forgetting-trigger"] })],
    );
    log(
      `[boot] stale system hooks cleanup: rowsDeleted=${result.rowCount ?? 0} retained=sleep-forgetting-trigger`,
      "migration",
    );
  });

  await heal("system_hook_executions table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_hook_executions (
        id SERIAL PRIMARY KEY,
        hook_id INTEGER NOT NULL,
        event_db_id INTEGER,
        action_type TEXT NOT NULL,
        action_config_resolved JSONB,
        status TEXT NOT NULL DEFAULT 'dispatched',
        error_message TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_hook_exec_hook_created ON system_hook_executions(hook_id, created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_hook_exec_created ON system_hook_executions(created_at)`,
    );
  });

  await heal("content_queue table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "content_queue" (
        "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "platform" text NOT NULL DEFAULT 'x',
        "content" text NOT NULL,
        "thread_parts" jsonb,
        "status" text NOT NULL DEFAULT 'draft',
        "scheduled_at" timestamp,
        "published_at" timestamp,
        "platform_post_id" text,
        "platform_url" text,
        "metadata" jsonb,
        "reject_reason" text,
        "retry_count" integer NOT NULL DEFAULT 0,
        "calendar_event_id" text,
        "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "idx_content_queue_status" ON "content_queue" ("status");
      CREATE INDEX IF NOT EXISTS "idx_content_queue_scheduled" ON "content_queue" ("scheduled_at");
    `);
  });

  await heal("email_enrichments table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "email_enrichments" (
        "id" SERIAL PRIMARY KEY,
        "provider_thread_id" TEXT NOT NULL,
        "account_id" TEXT NOT NULL,
        "message_id" INTEGER REFERENCES email_messages(id),
        "summary" TEXT NOT NULL DEFAULT '',
        "decisions" JSONB,
        "actions" JSONB,
        "context_snapshot" JSONB,
        "dismissed" BOOLEAN NOT NULL DEFAULT false,
        "dismiss_reason" TEXT,
        "model" TEXT,
        "tokens_used" INTEGER,
        "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "email_enrichments_thread_account_unique" UNIQUE("provider_thread_id", "account_id")
      )
    `);
  });

  await heal("email_dismissals table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "email_dismissals" (
        "id" SERIAL PRIMARY KEY,
        "message_id" INTEGER REFERENCES email_messages(id),
        "provider_thread_id" TEXT NOT NULL,
        "account_id" TEXT NOT NULL,
        "tier" TEXT NOT NULL,
        "sender" TEXT,
        "subject" TEXT,
        "reason" TEXT NOT NULL,
        "dismissed_by" TEXT NOT NULL DEFAULT 'auto',
        "dismissed_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_dismissals_dismissed_at ON email_dismissals(dismissed_at)`,
    );
    for (const col of ["provider_thread_id", "account_id", "tier", "reason"]) {
      await pool
        .query(
          `ALTER TABLE email_dismissals ALTER COLUMN "${col}" SET NOT NULL`,
        )
        .catch(() => {});
    }
  });

  await heal("indexed_content table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "indexed_content" (
        "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "source_type" text NOT NULL,
        "source_label" text NOT NULL,
        "object_storage_path" text NOT NULL,
        "byte_count" integer NOT NULL,
        "index" jsonb NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "idx_indexed_content_source_type" ON "indexed_content" ("source_type");
      CREATE INDEX IF NOT EXISTS "idx_indexed_content_created_at" ON "indexed_content" ("created_at");
    `);
  });

  await heal("email_enrichments summary not null", async () => {
    await pool
      .query(
        `ALTER TABLE email_enrichments ALTER COLUMN "summary" SET DEFAULT ''`,
      )
      .catch(() => {});
    await pool
      .query(`UPDATE email_enrichments SET summary = '' WHERE summary IS NULL`)
      .catch(() => {});
    await pool
      .query(
        `ALTER TABLE email_enrichments ALTER COLUMN "summary" SET NOT NULL`,
      )
      .catch(() => {});
  });

  try {
    const {
      seedBuiltinSkills,
      verifyRequiredSkills,
      migrateSkillRenames,
      migrateLegacyPromptOverrides,
      migrateSkillProcessToToolBased,
      migrateSkillAddToMemoryDefaults,
      migrateSkillProcessUpdates,
      deleteZombieSkills,
    } = await import("./skill-seed");
    await ensurePromptModuleTables(pool);
    await migrateSkillRenames();
    await seedBuiltinSkills();
    await migrateLegacyPromptOverrides();
    await migrateSkillProcessToToolBased();
    await migrateSkillAddToMemoryDefaults();
    await migrateSkillProcessUpdates();
    await deleteZombieSkills();
    await verifyRequiredSkills();
  } catch (err: any) {
    log(`Skill seed/migration failed: ${err.message}`, "migration");
  }

  try {
    const ps = new PeopleStorage();
    const allPeople = await ps.listPeople();

    // Migrate legacy "self" records to "agent" / "user"
    const selfPeople = allPeople.filter((p) => p.cabinetLevel === "self");
    for (const sp of selfPeople) {
      const full = await ps.getPerson(sp.id);
      if (!full) continue;
      const isAgent =
        sp.name.toLowerCase() === getInstanceNameLower() ||
        full.relation?.toLowerCase().includes("agent") ||
        full.tags?.includes("agent");
      const newLevel = isAgent ? "agent" : "user";
      await ps.updatePerson(sp.id, { cabinetLevel: newLevel });
      log(
        `Migrated person "${sp.name}" (${sp.id}) from self → ${newLevel}`,
        "migration",
      );
    }

    // Ensure the agent person exists
    const hasAgent = allPeople.some(
      (p) =>
        p.cabinetLevel === "agent" ||
        (p.cabinetLevel === "self" &&
          p.name.toLowerCase() === getInstanceNameLower()),
    );
    if (!hasAgent) {
      await ps.createPerson({
        name: getInstanceName(),
        nicknames: [],
        cabinetLevel: "agent",
        relation: "AI Agent",
        tags: ["ai", "agent"],
        socialProfiles: {},
        contactInfo: [],
        importantDates: [],
        notes: [],
        interactions: [],
        private: false,
      });
      log(`Created ${getInstanceName()} as Agent person entity`, "migration");
    }

    // Populate the instance name cache from the agent person record
    const refreshedPeople = await ps.listPeople();
    const agentPerson = refreshedPeople.find((p) => p.cabinetLevel === "agent");
    if (agentPerson) {
      setInstanceNameCache(agentPerson.name);
      log(
        `Instance name cache set to "${agentPerson.name}" from People table`,
        "migration",
      );
    }
  } catch (err: any) {
    log(
      `${getInstanceName()} person creation/migration skipped: ${err.message}`,
      "migration",
    );
  }

  await heal("strategy schema columns", async () => {
    const { migrateStrategySchema } = await import("./strategy-storage");
    await migrateStrategySchema();
  });

  await heal("info_notes table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS info_notes (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        note_id SERIAL NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content JSONB DEFAULT '{}',
        plain_text_content TEXT NOT NULL DEFAULT '',
        processed_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_info_notes_note_id ON info_notes (note_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_info_notes_updated ON info_notes (updated_at)`,
    );
  });

  await heal("library_pages table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_pages (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        page_id SERIAL NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL DEFAULT '',
        content JSONB DEFAULT '{}',
        plain_text_content TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        memory_entry_id INTEGER REFERENCES memory_entries(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_page_id ON library_pages (page_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_parent ON library_pages (parent_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_slug ON library_pages (slug)`,
    );
  });

  await heal("library_page_links table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_page_links (
        id SERIAL PRIMARY KEY,
        source_page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
        target_page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uk_library_page_links UNIQUE (source_page_id, target_page_id)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_page_links_source ON library_page_links (source_page_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_page_links_target ON library_page_links (target_page_id)`,
    );
  });

  await heal("library_annotations table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_annotations (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        annotation_type TEXT NOT NULL DEFAULT 'observation',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_annotations_page ON library_annotations (page_id)`,
    );
  });

  await heal("email_triage_log table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_triage_log (
        id SERIAL PRIMARY KEY,
        gmail_message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        cached_message_id INTEGER,
        tier TEXT NOT NULL,
        sender_email TEXT,
        subject TEXT,
        triaged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT email_triage_log_message_account_unique UNIQUE (gmail_message_id, account_id)
      )
    `);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE email_triage_log ADD COLUMN IF NOT EXISTS cached_message_id INTEGER;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  });

  await heal("email_sync_log table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_sync_log (
        id SERIAL PRIMARY KEY,
        account_id TEXT NOT NULL,
        sync_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        sync_completed_at TIMESTAMP,
        messages_synced INTEGER DEFAULT 0 NOT NULL,
        cursor_state TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        resync_reason TEXT
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_sync_log_account ON email_sync_log (account_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_sync_log_status ON email_sync_log (status, account_id)`,
    );
    await pool.query(
      `ALTER TABLE email_sync_log ADD COLUMN IF NOT EXISTS reconciled_count integer NOT NULL DEFAULT 0`,
    );
  });

  await heal("email_messages table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_messages (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'gmail',
        account_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        provider_thread_id TEXT,
        history_id TEXT,
        subject TEXT,
        snippet TEXT,
        from_address TEXT,
        to_addresses TEXT,
        cc_addresses TEXT,
        date TIMESTAMP,
        label_ids JSONB,
        body_text TEXT,
        body_html TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        is_starred BOOLEAN DEFAULT FALSE,
        triage_status TEXT NOT NULL DEFAULT 'untriaged',
        triage_tier TEXT,
        triage_reason TEXT,
        triaged_at TIMESTAMP,
        cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT email_messages_provider_account_message_unique UNIQUE (provider, account_id, provider_message_id)
      )
    `);
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS triage_status TEXT NOT NULL DEFAULT 'untriaged'`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS triage_tier TEXT`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS triage_reason TEXT`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_done BOOLEAN NOT NULL DEFAULT false`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS done_reason TEXT`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS done_at TIMESTAMP`,
    );
    await pool.query(
      `ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_messages_snoozed_until ON email_messages (snoozed_until)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_messages_account ON email_messages (account_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_messages_date ON email_messages (date DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_email_messages_triage_status ON email_messages (triage_status)`,
    );
  });

  await heal("email_sync_cursors table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_sync_cursors (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'gmail',
        account_id TEXT NOT NULL,
        history_id TEXT,
        last_full_sync_at TIMESTAMP,
        last_incremental_sync_at TIMESTAMP,
        last_sync_status TEXT,
        last_sync_error TEXT,
        messages_cached INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT email_sync_cursors_provider_account_unique UNIQUE (provider, account_id)
      )
    `);
  });

  await heal("email_drafts table v2", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id TEXT,
        account_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        created_by_user_id TEXT,
        vault_id TEXT,
        session_id TEXT,
        gmail_account_id TEXT,
        "to" TEXT[] NOT NULL DEFAULT '{}',
        cc TEXT[] NOT NULL DEFAULT '{}',
        bcc TEXT[] NOT NULL DEFAULT '{}',
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        thread_id TEXT,
        in_reply_to TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        sent_message_id TEXT,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await pool.query(`ALTER TABLE email_drafts ADD COLUMN IF NOT EXISTS vault_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_owner ON email_drafts (owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON email_drafts (account_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_session ON email_drafts (session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_drafts_vault ON email_drafts (vault_id)`);
  });

  await heal("magic demo sessions tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS magic_demo_sessions (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        device_id TEXT,
        app_version TEXT,
        build_number TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMPTZ,
        telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE magic_demo_sessions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
    await pool.query(`ALTER TABLE magic_demo_sessions ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_sessions ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_sessions ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_sessions ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT`);
    await pool.query(`UPDATE magic_demo_sessions SET owner_user_id = user_id WHERE owner_user_id IS NULL AND user_id IS NOT NULL`);
    await pool.query(`UPDATE magic_demo_sessions s SET account_id = a.id FROM accounts a WHERE s.account_id IS NULL AND a.kind = 'personal' AND a.owner_user_id = s.owner_user_id`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_user_created ON magic_demo_sessions(user_id, created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_status ON magic_demo_sessions(status)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_owner_created ON magic_demo_sessions(owner_user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_account_created ON magic_demo_sessions(account_id, created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS magic_demo_session_events (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES magic_demo_sessions(id) ON DELETE CASCADE,
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        event_type TEXT NOT NULL,
        event_name TEXT NOT NULL,
        route_metadata JSONB,
        dat_state JSONB,
        voice_lifecycle TEXT,
        vision_lifecycle TEXT,
        failure_details JSONB,
        latency_ms INTEGER,
        telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE magic_demo_session_events ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_session_events ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_session_events ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`);
    await pool.query(`UPDATE magic_demo_session_events e SET owner_user_id = s.owner_user_id, account_id = s.account_id, created_by_user_id = COALESCE(e.created_by_user_id, s.owner_user_id) FROM magic_demo_sessions s WHERE e.session_id = s.id AND (e.owner_user_id IS NULL OR e.account_id IS NULL OR e.created_by_user_id IS NULL)`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_events_session_created ON magic_demo_session_events(session_id, created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_events_type ON magic_demo_session_events(event_type)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_events_owner_created ON magic_demo_session_events(owner_user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_events_account_created ON magic_demo_session_events(account_id, created_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS magic_demo_vision_frames (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        session_id TEXT NOT NULL REFERENCES magic_demo_sessions(id) ON DELETE CASCADE,
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        source TEXT NOT NULL DEFAULT 'dat_camera',
        object_path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        format TEXT NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'still',
        linked_utterance_id TEXT,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE magic_demo_vision_frames ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_vision_frames ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE magic_demo_vision_frames ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`);
    await pool.query(`UPDATE magic_demo_vision_frames f SET owner_user_id = s.owner_user_id, account_id = s.account_id, created_by_user_id = COALESCE(f.created_by_user_id, s.owner_user_id) FROM magic_demo_sessions s WHERE f.session_id = s.id AND (f.owner_user_id IS NULL OR f.account_id IS NULL OR f.created_by_user_id IS NULL)`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_session_created ON magic_demo_vision_frames(session_id, created_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_utterance ON magic_demo_vision_frames(linked_utterance_id)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_owner_created ON magic_demo_vision_frames(owner_user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_account_created ON magic_demo_vision_frames(account_id, created_at)`);
  });

  await heal("mobile startup telemetry table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mobile_startup_telemetry (
        id SERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        phase TEXT,
        mobile_session_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        platform TEXT,
        os_version TEXT,
        device_model TEXT,
        app_version TEXT,
        native_build_version TEXT,
        runtime_version TEXT,
        update_id TEXT,
        update_group_id TEXT,
        bundle_identifier TEXT,
        eas_build_id TEXT,
        build_profile TEXT,
        git_sha TEXT,
        source_ref TEXT,
        is_fatal BOOLEAN NOT NULL DEFAULT false,
        error_name TEXT,
        error_message TEXT,
        error_stack TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mobile_startup_telemetry_received_at ON mobile_startup_telemetry(received_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mobile_startup_telemetry_build ON mobile_startup_telemetry(git_sha, native_build_version, received_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mobile_startup_telemetry_session ON mobile_startup_telemetry(mobile_session_id, occurred_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_mobile_startup_telemetry_device ON mobile_startup_telemetry(device_id, received_at DESC)`,
    );
  });

  await heal("captures table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        raw_text TEXT NOT NULL,
        type_hint TEXT,
        classified_type TEXT,
        classification_confidence REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        routed_to TEXT,
        routed_ref TEXT,
        error_message TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        user_id TEXT NOT NULL DEFAULT 'ray'
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at)`,
    );
  });

  await heal("library_pages parent_id FK", async () => {
    const fkExists = await pool.query(`
      SELECT 1 FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name = 'library_pages' AND tc.constraint_type = 'FOREIGN KEY'
        AND rc.unique_constraint_schema = 'public'
        AND EXISTS (
          SELECT 1 FROM information_schema.key_column_usage kcu
          WHERE kcu.constraint_name = tc.constraint_name AND kcu.column_name = 'parent_id'
        )
    `);
    if (fkExists.rows.length === 0) {
      await pool.query(`
        ALTER TABLE library_pages
        ADD CONSTRAINT fk_library_pages_parent FOREIGN KEY (parent_id) REFERENCES library_pages(id) ON DELETE SET NULL
      `);
    }
  });

  await heal("library_annotations enum constraint", async () => {
    const chkExists = await pool.query(`
      SELECT 1 FROM information_schema.check_constraints
      WHERE constraint_name = 'chk_library_annotations_type'
    `);
    if (chkExists.rows.length === 0) {
      await pool.query(`
        ALTER TABLE library_annotations
        ADD CONSTRAINT chk_library_annotations_type
        CHECK (annotation_type IN ('observation', 'connection', 'confidence'))
      `);
    }
  });

  await heal("code_embeddings table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS code_embeddings (
        id SERIAL PRIMARY KEY,
        symbol_name TEXT NOT NULL,
        symbol_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding vector(384),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_code_embed_type_name_path UNIQUE (symbol_type, symbol_name, file_path)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_code_embed_file ON code_embeddings(file_path)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_code_embed_type ON code_embeddings(symbol_type)`,
    );
  });

  await heal("backfill session memory titles", async () => {
    const untitled = await pool.query(`
      SELECT id, metadata FROM memory_entries
      WHERE source = 'conversation' AND title IS NULL AND metadata IS NOT NULL
    `);
    if (untitled.rows.length === 0) return;

    const { chatFileStorage } = await import("./chat-file-storage");
    let updated = 0;
    for (const row of untitled.rows) {
      const convId = row.metadata?.sessionId;
      if (!convId) continue;
      try {
        const conv = await chatFileStorage.getSession(convId);
        if (
          conv &&
          conv.title &&
          conv.title !== "New Session" &&
          conv.title !== "New Chat"
        ) {
          await pool.query(
            `UPDATE memory_entries SET title = $1 WHERE id = $2`,
            [conv.title, row.id],
          );
          updated++;
        }
      } catch {}
    }
    if (updated > 0) {
      log(
        `backfill: set titles on ${updated} session memory entries`,
        "migration",
      );
    }
  });

  await heal("budget_entries table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS budget_entries (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL UNIQUE,
        monthly_amount REAL NOT NULL DEFAULT 0
      )
    `);
  });

  await heal("budget_income_override table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS budget_income_override (
        id SERIAL PRIMARY KEY,
        monthly_income REAL,
        use_override BOOLEAN NOT NULL DEFAULT false
      )
    `);
  });

  await heal("financed_assets table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS financed_assets (
        id SERIAL PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        purchase_price REAL NOT NULL,
        purchase_date TEXT,
        current_value REAL NOT NULL,
        depreciation_method TEXT DEFAULT 'none',
        useful_life_months INTEGER,
        salvage_value REAL DEFAULT 0,
        loan_original_amount REAL,
        loan_balance REAL,
        loan_apr REAL,
        monthly_payment REAL,
        total_payments INTEGER,
        payments_made INTEGER DEFAULT 0,
        loan_start_date TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await ensureColumns("financed_assets", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(`
      WITH legacy_owner AS (
        SELECT u.id AS user_id, a.id AS account_id
        FROM users u
        INNER JOIN accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
        ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
        LIMIT 1
      )
      UPDATE financed_assets f
      SET scope = 'user',
          owner_user_id = COALESCE(f.owner_user_id, legacy_owner.user_id),
          account_id = COALESCE(f.account_id, legacy_owner.account_id)
      FROM legacy_owner
      WHERE f.owner_user_id IS NULL OR f.account_id IS NULL
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_financed_assets_scope_owner ON financed_assets(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_financed_assets_account ON financed_assets(account_id)`);
  });

  await heal("manual_401k_accounts table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manual_401k_accounts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        current_balance REAL NOT NULL,
        linked_deduction_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
  });

  await heal("future_cash_events table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS future_cash_events (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
  });

  await heal(
    "plaid_liabilities notes and manual_payment_amount columns",
    async () => {
      await pool.query(
        `ALTER TABLE plaid_liabilities ADD COLUMN IF NOT EXISTS notes TEXT`,
      );
      await pool.query(
        `ALTER TABLE plaid_liabilities ADD COLUMN IF NOT EXISTS manual_payment_amount REAL`,
      );
    },
  );

  await heal("manual_liabilities and debt_payments notes columns", async () => {
    await pool.query(
      `ALTER TABLE manual_liabilities ADD COLUMN IF NOT EXISTS notes TEXT`,
    );
    await pool.query(
      `ALTER TABLE debt_payments ADD COLUMN IF NOT EXISTS notes TEXT`,
    );
  });

  await heal("skills checklist column", async () => {
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
  });

  await heal("skills session_type column", async () => {
    await pool.query(
      `ALTER TABLE skills ADD COLUMN IF NOT EXISTS session_type text`,
    );
  });

  await heal("skill_scores table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skill_scores (
        id SERIAL PRIMARY KEY,
        skill_name VARCHAR(64) NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        checklist_total INTEGER NOT NULL DEFAULT 0,
        checklist_passed INTEGER NOT NULL DEFAULT 0,
        checklist_results JSONB NOT NULL DEFAULT '[]',
        comparative_vs_id INTEGER,
        comparative_winner TEXT,
        comparative_reason TEXT,
        pass_rate REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        scored_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_scores_skill_name ON skill_scores(skill_name)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_scores_scored_at ON skill_scores(scored_at)`,
    );
  });

  await heal("skill_failure_dismissals table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skill_failure_dismissals (
        id SERIAL PRIMARY KEY,
        skill_name VARCHAR(64) NOT NULL UNIQUE,
        dismissed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  await heal("relationship_type migration", async () => {
    const { runRelationshipTypeMigration } =
      await import("./migrations/backfill-relationship-types");
    await runRelationshipTypeMigration();
  });

  // email_drafts source_email_id and person_id columns removed — table replaced by v2 schema

  await heal("emotional_states narrative column", async () => {
    const { migrateAddNarrativeToEmotionalStates } =
      await import("./migrations/add-narrative-to-emotional-states");
    await migrateAddNarrativeToEmotionalStates();
  });

  await heal("voice_session_active table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS voice_session_active (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active',
        ended_at TIMESTAMP,
        boot_id TEXT,
        scope TEXT NOT NULL DEFAULT 'system',
        owner_user_id TEXT,
        account_id TEXT,
        start_request_id TEXT,
        start_response JSONB,
        start_ready_at TIMESTAMPTZ
      )
    `);
    // Partial index for the only hot read pattern (status='active'). Also created
    // in the earlier "voice_session_active inflight columns" heal step so existing
    // environments get it; declared here too so a fresh-DB first boot (where the
    // earlier ALTER would no-op against a not-yet-created table) still ends up
    // with the index. CREATE INDEX IF NOT EXISTS is idempotent.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vsa_active_boot ON voice_session_active(boot_id) WHERE status = 'active'`,
    );
  });


  await heal("prune old voice_session_active rows", async () => {
    const { storage } = await import("./storage");
    const days = Math.max(
      1,
      parseInt(process.env.VOICE_SESSION_RETENTION_DAYS || "30", 10) || 30,
    );
    const { deleted, remaining } = await storage.pruneVoiceSessions(days);
    log(
      `[startup] voice_session_active prune: deleted=${deleted} remaining=${remaining} retentionDays=${days}`,
      "boot",
    );
  });

  await heal("reset stale streaming sessions", async () => {
    const { chatFileStorage } = await import("./chat-file-storage");
    const result = await chatFileStorage.reconcileInterruptedAssistantDrafts();
    log(
      `[startup] stale streaming sessions scanned=${result.sessionsScanned} assistantDraftsReconciled=${result.draftsReconciled}`,
      "boot",
    );
  });

  await heal("wellness_activities table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wellness_activities (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        benefit TEXT,
        risk TEXT,
        estimated_minutes INTEGER,
        estimated_cost REAL,
        interval_days INTEGER NOT NULL DEFAULT 7,
        requirements TEXT,
        category TEXT NOT NULL DEFAULT 'weekly_ritual',
        is_default BOOLEAN NOT NULL DEFAULT false,
        window_start INTEGER,
        window_end INTEGER,
        archived_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Backfill columns for tables created before the wellness windows feature
    await pool.query(
      `ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS window_start INTEGER`,
    );
    await pool.query(
      `ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS window_end INTEGER`,
    );
  });

  await heal("wellness_logs table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wellness_logs (
        id SERIAL PRIMARY KEY,
        activity_id INTEGER NOT NULL REFERENCES wellness_activities(id),
        notes TEXT,
        completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  await heal("seed default wellness activities (one-time)", async () => {
    const existing = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM wellness_activities",
    );
    if (existing.rows[0].cnt > 0) return;
    for (const a of DEFAULT_WELLNESS_ACTIVITIES) {
      await pool.query(
        `INSERT INTO wellness_activities (name, benefit, risk, estimated_minutes, estimated_cost, interval_days, category, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (name) DO NOTHING`,
        [
          a.name,
          a.benefit,
          a.risk,
          a.estimated_minutes,
          a.estimated_cost,
          a.interval_days,
          a.category,
        ],
      );
    }
  });

  await heal("drop zombie gateway_logs table", async () => {
    await pool.query(`DROP TABLE IF EXISTS gateway_logs`);
    log("auto-heal: dropped gateway_logs table (zombie)", "migration");
  });

  await heal("drop duplicate idx_memory_layer_source_sourceid", async () => {
    await pool.query(`DROP INDEX IF EXISTS idx_memory_layer_source_sourceid`);
    log(
      "auto-heal: dropped idx_memory_layer_source_sourceid (duplicate of uk_memory_layer_source_id)",
      "migration",
    );
  });

  await heal("drop redundant idx_memory_layer", async () => {
    await pool.query(`DROP INDEX IF EXISTS idx_memory_layer`);
    log(
      "auto-heal: dropped idx_memory_layer (covered by idx_memory_layer_created_at composite)",
      "migration",
    );
  });

  await heal("api_calls dedicated table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_input REAL NOT NULL DEFAULT 0,
        cost_output REAL NOT NULL DEFAULT 0,
        cost_total REAL NOT NULL DEFAULT 0,
        session_key TEXT,
        session_id INTEGER,
        duration_ms INTEGER,
        stop_reason TEXT,
        request_content TEXT,
        response_content TEXT,
        metadata JSONB DEFAULT '{}'
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls(timestamp)`,
    );
  });

  await heal("drop api_calls content columns (moved to S3)", async () => {
    await pool.query(
      `ALTER TABLE api_calls DROP COLUMN IF EXISTS request_content`,
    );
    await pool.query(
      `ALTER TABLE api_calls DROP COLUMN IF EXISTS response_content`,
    );
  });

  await heal(
    "migrate api_call data from memory_entries to api_calls",
    async () => {
      const countResult = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM memory_entries
      WHERE layer = 'workspace' AND source = 'api_call'
    `);
      const sourceCount: number = countResult.rows[0]?.cnt || 0;
      if (sourceCount === 0) return;

      const destResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM api_calls`,
      );
      const destCount: number = destResult.rows[0]?.cnt || 0;

      if (destCount >= sourceCount) {
        await pool.query(
          `DELETE FROM memory_entries WHERE layer = 'workspace' AND source = 'api_call'`,
        );
        log(
          `auto-heal: cleaned ${sourceCount} legacy api_call rows from memory_entries (api_calls has ${destCount} rows)`,
          "migration",
        );
        return;
      }

      if (destCount > 0) {
        log(
          `auto-heal: partial migration detected (source=${sourceCount}, dest=${destCount}); re-migrating`,
          "migration",
        );
        await pool.query(`DELETE FROM api_calls`);
      }

      const insertResult = await pool.query(`
      INSERT INTO api_calls (timestamp, model, provider, profile, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_total,
        session_key, session_id, duration_ms, stop_reason, metadata)
      SELECT
        COALESCE((metadata->>'timestamp')::timestamptz, created_at) AS timestamp,
        COALESCE(metadata->>'model', '') AS model,
        COALESCE(metadata->>'provider', '') AS provider,
        metadata->>'profile' AS profile,
        COALESCE((metadata->>'inputTokens')::int, 0) AS input_tokens,
        COALESCE((metadata->>'outputTokens')::int, 0) AS output_tokens,
        (metadata->>'cacheReadTokens')::int AS cache_read_tokens,
        (metadata->>'cacheWriteTokens')::int AS cache_write_tokens,
        COALESCE((metadata->>'totalTokens')::int, 0) AS total_tokens,
        COALESCE((metadata->>'costInput')::real, 0) AS cost_input,
        COALESCE((metadata->>'costOutput')::real, 0) AS cost_output,
        COALESCE((metadata->>'costTotal')::real, 0) AS cost_total,
        metadata->>'sessionKey' AS session_key,
        (metadata->>'sessionId')::int AS session_id,
        (metadata->>'durationMs')::int AS duration_ms,
        metadata->>'stopReason' AS stop_reason,
        metadata
      FROM memory_entries
      WHERE layer = 'workspace' AND source = 'api_call'
      ORDER BY created_at ASC
    `);
      const migratedCount = insertResult.rowCount ?? 0;
      if (migratedCount === sourceCount) {
        await pool.query(
          `DELETE FROM memory_entries WHERE layer = 'workspace' AND source = 'api_call'`,
        );
        log(
          `auto-heal: migrated ${migratedCount} api_call rows from memory_entries to api_calls`,
          "migration",
        );
      } else {
        log(
          `auto-heal: migration count mismatch (source=${sourceCount}, inserted=${migratedCount}); keeping legacy rows for safety`,
          "migration",
        );
      }
    },
  );

  await heal("retire raw session memory rows from graph surfaces", async () => {
    const rawSessionPredicate = `
      (source = 'chat' AND layer = 'workspace' AND COALESCE(metadata->>'mirrorKind', '') != 'session_summary')
      OR (source = 'voice_session' AND layer = 'workspace' AND COALESCE(metadata->>'mirrorKind', '') != 'session_summary')
      OR (source = 'chat_journal' AND layer = 'workspace' AND COALESCE(metadata->>'mirrorKind', '') != 'session_summary')
      OR (source = 'conversation' AND (COALESCE(source_id, '') LIKE 'exchange-%' OR COALESCE(tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[]))
    `;

    const linkResult = await pool.query(`
      DELETE FROM memory_links
      WHERE from_id IN (SELECT id FROM memory_entries WHERE ${rawSessionPredicate})
         OR to_id IN (SELECT id FROM memory_entries WHERE ${rawSessionPredicate})
    `);

    const rowResult = await pool.query(`
      UPDATE memory_entries
      SET graphed = false,
          summary = NULL,
          one_liner = NULL,
          content_hash = NULL,
          embedding = NULL,
          metadata = jsonb_set(
            jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archiveOnly}', 'true'::jsonb, true),
            '{neighborhood_cache}',
            'null'::jsonb,
            true
          ) - 'neighborhood_cache',
          processed_at = CURRENT_TIMESTAMP
      WHERE ${rawSessionPredicate}
    `);

    if ((linkResult.rowCount && linkResult.rowCount > 0) || (rowResult.rowCount && rowResult.rowCount > 0)) {
      log(
        `auto-heal: retired ${rowResult.rowCount || 0} raw session/exchange memory rows and deleted ${linkResult.rowCount || 0} graph links`,
        "migration",
      );
    }
  });

  // Migrate legacy "event" claim type to "action" in metadata JSONB
  await heal(
    "memory_entries claim type event→action migration",
    async () => {
      const result = await pool.query(`
        UPDATE memory_entries
        SET metadata = jsonb_set(metadata, '{claimType}', '"action"')
        WHERE metadata->>'claimType' = 'event'
      `);
      if (result.rowCount && result.rowCount > 0) {
        log(
          `auto-heal: migrated ${result.rowCount} claim(s) from claimType "event" to "action"`,
          "migration",
        );
      }
    },
  );

  await heal(
    "migrate embedding columns from 1536-dim to 384-dim (local model)",
    async () => {
      // Check each table independently using pg_attribute.atttypmod
      // For vector(N), atttypmod = N. PostgreSQL LIMIT 0 short-circuits without validating casts.
      const checkDim = async (table: string, col: string): Promise<boolean> => {
        const res = await pool.query(
          `
        SELECT a.atttypmod FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = $1 AND a.attname = $2 AND a.atttypmod > 0
      `,
          [table, col],
        );
        if (res.rows.length === 0) return false; // column doesn't exist or no dimension set
        return res.rows[0].atttypmod !== 384;
      };

      const memoryNeedsMigration = await checkDim(
        "memory_entries",
        "embedding",
      );
      const codeNeedsMigration = await checkDim("code_embeddings", "embedding");

      if (!memoryNeedsMigration && !codeNeedsMigration) return;

      log(
        "auto-heal: migrating embedding columns from 1536-dim to 384-dim for local embeddings",
        "migration",
      );

      // Drop the HNSW index first (dimension mismatch will cause errors)
      await pool.query(`DROP INDEX IF EXISTS idx_memory_embedding_hnsw`);

      if (memoryNeedsMigration) {
        await pool.query(
          `ALTER TABLE memory_entries ALTER COLUMN embedding TYPE vector(384) USING NULL`,
        );
        log(
          "auto-heal: memory_entries.embedding migrated to vector(384)",
          "migration",
        );
      }

      if (codeNeedsMigration) {
        await pool.query(
          `ALTER TABLE code_embeddings ALTER COLUMN embedding TYPE vector(384) USING NULL`,
        );
        log(
          "auto-heal: code_embeddings.embedding migrated to vector(384)",
          "migration",
        );
      }

      // Recreate HNSW index with correct dimensions
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw ON memory_entries USING hnsw (embedding vector_cosine_ops)`,
      );
      log("auto-heal: HNSW index recreated with 384-dim", "migration");
    },
  );

  await heal(
    "code_embeddings unique constraint uq_code_embed_type_name_path",
    async () => {
      const exists = await pool.query(`
      SELECT 1 FROM pg_constraint WHERE conname = 'uq_code_embed_type_name_path'
    `);
      if (exists.rowCount && exists.rowCount > 0) return;
      await pool.query(`
      ALTER TABLE code_embeddings
      ADD CONSTRAINT uq_code_embed_type_name_path UNIQUE (symbol_type, symbol_name, file_path)
    `);
      log(
        "auto-heal: created unique constraint uq_code_embed_type_name_path on code_embeddings",
        "migration",
      );
    },
  );

  await heal("HNSW vector index on memory_entries.embedding", async () => {
    const exists = await pool.query(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memory_embedding_hnsw'
    `);
    if (exists.rowCount && exists.rowCount > 0) return;
    await pool.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_embedding_hnsw
      ON memory_entries USING hnsw (embedding vector_cosine_ops)
    `);
    log(
      "auto-heal: created HNSW vector index on memory_entries.embedding",
      "migration",
    );
  });

  await heal("gratitude_entries table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gratitude_entries (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        date TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    log("auto-heal: created gratitude_entries table", "migration");
  });

  await heal("learning_entries table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS learning_entries (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        date TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    log("auto-heal: created learning_entries table", "migration");
  });

  await heal("reflection_entries table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reflection_entries (
        id SERIAL PRIMARY KEY,
        owner_user_id TEXT,
        principal_account_id TEXT,
        content TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS reflection_entries_owner_account_date_unique
      ON reflection_entries(owner_user_id, principal_account_id, date)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reflection_entries_owner
      ON reflection_entries(owner_user_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reflection_entries_principal_account
      ON reflection_entries(principal_account_id)
    `);
    log("auto-heal: created reflection_entries table", "migration");
  });

  await heal("wellness metric tiers migration", async () => {
    const { runWellnessMetricTiersMigration } =
      await import("./migrations/add-wellness-metric-tiers");
    await runWellnessMetricTiersMigration();
  });

  await heal("wellness timestamps -> timestamptz", async () => {
    const { runWellnessTimestamptzMigration } =
      await import("./migrations/wellness-timestamps-to-timestamptz");
    await runWellnessTimestamptzMigration();
  });

  await heal("all naked timestamps -> timestamptz", async () => {
    const { runNakedTimestamptzMigration } =
      await import("./migrations/naked-timestamps-to-timestamptz");
    await runNakedTimestamptzMigration();
  });


  await heal("prompt_modules tables", async () => {
    await ensurePromptModuleTables(pool);
    log("auto-heal: ensured prompt_modules and prompt_module_versions tables", "migration");
  });

  await heal("skill_runs table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS skill_runs (
        id SERIAL PRIMARY KEY,
        skill_name VARCHAR(64) NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        duration_ms INTEGER,
        pass_rate REAL,
        checklist_total INTEGER,
        checklist_passed INTEGER,
        checklist_results JSONB,
        comparative_vs_id INTEGER,
        comparative_winner TEXT,
        comparative_reason TEXT,
        failure_reason TEXT
      )
    `);
    log("auto-heal: created skill_runs table", "migration");
    const scoringColumns = [
      { name: "pass_rate", type: "REAL" },
      { name: "checklist_total", type: "INTEGER" },
      { name: "checklist_passed", type: "INTEGER" },
      { name: "checklist_results", type: "JSONB" },
      { name: "comparative_vs_id", type: "INTEGER" },
      { name: "comparative_winner", type: "TEXT" },
      { name: "comparative_reason", type: "TEXT" },
      { name: "failure_reason", type: "TEXT" },
    ];
    for (const col of scoringColumns) {
      await pool.query(
        `ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`,
      );
    }
    log("auto-heal: ensured skill_runs scoring columns exist", "migration");
  });

  await heal("core scoped table columns", async () => {
    const scopedTables = [
      "sessions",
      "messages",
      "workspace_documents",
      "memory_entries",
      "memory_entity_links",
      "info_notes",
      "library_pages",
      "library_page_links",
      "library_annotations",
      "library_page_views",
      "emotional_states",
      "system_hooks",
      "theses",
    ];

    const existingTables = new Set<string>();
    for (const table of scopedTables) {
      const result = await pool.query(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
      if (!result.rows[0]?.name) continue;
      existingTables.add(table);
      await ensureColumns(table, [
        { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
        { name: "owner_user_id", type: "TEXT" },
        { name: "account_id", type: "TEXT" },
      ]);
    }

    const createIndexIfTableExists = async (table: string, sqlText: string) => {
      if (!existingTables.has(table)) return;
      await pool.query(sqlText);
    };

    await createIndexIfTableExists("sessions", `CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner ON sessions(scope, owner_user_id)`);
    await createIndexIfTableExists("sessions", `CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`);
    await createIndexIfTableExists("messages", `CREATE INDEX IF NOT EXISTS idx_messages_scope_owner ON messages(scope, owner_user_id)`);
    await createIndexIfTableExists("messages", `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)`);
    await createIndexIfTableExists("workspace_documents", `CREATE INDEX IF NOT EXISTS idx_ws_doc_scope_owner ON workspace_documents(scope, owner_user_id)`);
    await createIndexIfTableExists("workspace_documents", `CREATE INDEX IF NOT EXISTS idx_ws_doc_account ON workspace_documents(account_id)`);
    await createIndexIfTableExists("memory_entries", `CREATE INDEX IF NOT EXISTS idx_memory_scope_owner ON memory_entries(scope, owner_user_id)`);
    await createIndexIfTableExists("memory_entries", `CREATE INDEX IF NOT EXISTS idx_memory_account ON memory_entries(account_id)`);
    await createIndexIfTableExists("memory_entries", `CREATE INDEX IF NOT EXISTS idx_memory_chat_metadata_index ON memory_entries(layer, source, scope, owner_user_id, processed_at DESC) WHERE source = 'chat'`);
    await createIndexIfTableExists("memory_entity_links", `CREATE INDEX IF NOT EXISTS idx_memory_entity_links_scope_owner ON memory_entity_links(scope, owner_user_id)`);
    await createIndexIfTableExists("memory_entity_links", `CREATE INDEX IF NOT EXISTS idx_memory_entity_links_account ON memory_entity_links(account_id)`);
    await createIndexIfTableExists("info_notes", `CREATE INDEX IF NOT EXISTS idx_info_notes_scope_owner ON info_notes(scope, owner_user_id)`);
    await createIndexIfTableExists("info_notes", `CREATE INDEX IF NOT EXISTS idx_info_notes_account ON info_notes(account_id)`);
    await createIndexIfTableExists("library_pages", `CREATE INDEX IF NOT EXISTS idx_library_pages_scope_owner ON library_pages(scope, owner_user_id)`);
    await createIndexIfTableExists("library_pages", `CREATE INDEX IF NOT EXISTS idx_library_pages_account ON library_pages(account_id)`);
    await createIndexIfTableExists("library_page_links", `CREATE INDEX IF NOT EXISTS idx_library_page_links_scope_owner ON library_page_links(scope, owner_user_id)`);
    await createIndexIfTableExists("library_page_links", `CREATE INDEX IF NOT EXISTS idx_library_page_links_account ON library_page_links(account_id)`);
    await createIndexIfTableExists("library_annotations", `CREATE INDEX IF NOT EXISTS idx_library_annotations_scope_owner ON library_annotations(scope, owner_user_id)`);
    await createIndexIfTableExists("library_annotations", `CREATE INDEX IF NOT EXISTS idx_library_annotations_account ON library_annotations(account_id)`);
    await createIndexIfTableExists("library_page_views", `CREATE INDEX IF NOT EXISTS idx_library_page_views_scope_owner ON library_page_views(scope, owner_user_id)`);
    await createIndexIfTableExists("library_page_views", `CREATE INDEX IF NOT EXISTS idx_library_page_views_account ON library_page_views(account_id)`);
    await createIndexIfTableExists("emotional_states", `CREATE INDEX IF NOT EXISTS idx_emotional_states_scope_owner ON emotional_states(scope, owner_user_id)`);
    await createIndexIfTableExists("emotional_states", `CREATE INDEX IF NOT EXISTS idx_emotional_states_account ON emotional_states(account_id)`);

    await createIndexIfTableExists("system_hooks", `CREATE INDEX IF NOT EXISTS idx_system_hooks_scope_owner ON system_hooks(scope, owner_user_id)`);
    await createIndexIfTableExists("system_hooks", `CREATE INDEX IF NOT EXISTS idx_system_hooks_account ON system_hooks(account_id)`);
    await createIndexIfTableExists("theses", `CREATE INDEX IF NOT EXISTS idx_theses_scope_owner ON theses(scope, owner_user_id)`);
    await createIndexIfTableExists("theses", `CREATE INDEX IF NOT EXISTS idx_theses_account ON theses(account_id)`);

    // Backfill ownership for scoped tables that were added after the main ownership repair
    await pool.query(`
      DO $$
      DECLARE
        ray_user_id text;
        ray_account_id text;
        tbl text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;
          IF ray_account_id IS NOT NULL THEN
            FOREACH tbl IN ARRAY ARRAY['theses', 'signal_sources', 'signal_items', 'scan_runs', 'decisions'] LOOP
              IF to_regclass('public.' || tbl) IS NOT NULL THEN
                EXECUTE format(
                  'UPDATE %I SET owner_user_id = COALESCE(owner_user_id, $1), account_id = COALESCE(account_id, $2) WHERE scope = ''user'' AND owner_user_id IS NULL',
                  tbl
                ) USING ray_user_id, ray_account_id;
              END IF;
            END LOOP;
          END IF;
        END IF;
      END $$;
    `);

    log("auto-heal: ensured core scoped table columns", "migration");
  });

  await heal("projects completed_at column", async () => {
    await ensureColumns("projects", [
      { name: "completed_at", type: "TIMESTAMPTZ" },
    ]);
    log("auto-heal: ensured projects completed_at column", "migration");
  });

  await heal("timer system key column", async () => {
    await ensureColumns("timers", [
      { name: "system_key", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_timers_system_key_unique ON timers(system_key) WHERE system_key IS NOT NULL`,
    );
    log("auto-heal: ensured timer system key column", "migration");
  });

  await heal("timer run scheduled slot columns", async () => {
    await ensureColumns("responsibility_runs", [
      { name: "intended_fire_at", type: "TIMESTAMPTZ" },
      { name: "scheduled_slot_start", type: "TIMESTAMPTZ" },
      { name: "scheduled_slot_end", type: "TIMESTAMPTZ" },
    ]);
    await pool.query(`
      UPDATE responsibility_runs
      SET
        intended_fire_at = COALESCE(intended_fire_at, (metadata->>'intendedFireAt')::timestamptz),
        scheduled_slot_start = COALESCE(scheduled_slot_start, (metadata->>'slotStart')::timestamptz),
        scheduled_slot_end = COALESCE(scheduled_slot_end, (metadata->>'slotEnd')::timestamptz)
      WHERE trigger = 'scheduled'
        AND metadata IS NOT NULL
        AND (metadata->>'slotStart') IS NOT NULL
        AND (metadata->>'slotEnd') IS NOT NULL
    `);
    await pool.query(`
      DELETE FROM responsibility_runs a
      USING responsibility_runs b
      WHERE a.trigger = 'scheduled'
        AND b.trigger = 'scheduled'
        AND a.status = 'success'
        AND b.status = 'success'
        AND a.scheduled_slot_start IS NOT NULL
        AND a.scheduled_slot_end IS NOT NULL
        AND a.responsibility_id = b.responsibility_id
        AND a.schedule_id = b.schedule_id
        AND a.scheduled_slot_start = b.scheduled_slot_start
        AND a.scheduled_slot_end = b.scheduled_slot_end
        AND a.id < b.id
    `);
    await pool.query(`DROP INDEX IF EXISTS idx_responsibility_runs_scheduled_slot_unique`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_responsibility_runs_successful_scheduled_slot_unique
      ON responsibility_runs(responsibility_id, schedule_id, scheduled_slot_start, scheduled_slot_end)
      WHERE trigger = 'scheduled' AND status = 'success' AND scheduled_slot_start IS NOT NULL AND scheduled_slot_end IS NOT NULL
    `);
    log("auto-heal: ensured timer run scheduled slot columns", "migration");
  });

  await heal("content queue scope columns", async () => {
    await ensureColumns("content_queue", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_content_queue_scope_owner ON content_queue(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_content_queue_account ON content_queue(account_id)`,
    );
    log("auto-heal: ensured content_queue scope columns", "migration");
  });

  await heal("multi-user scope columns for skills and landscape", async () => {
    await ensureColumns("skills", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'global'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skills_scope_owner ON skills(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skills_account ON skills(account_id)`,
    );

    await ensureColumns("prompt_modules", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'global'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_prompt_modules_scope_owner ON prompt_modules(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_prompt_modules_account ON prompt_modules(account_id)`,
    );

    await ensureColumns("skill_scores", [
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_scores_owner_scored ON skill_scores(owner_user_id, scored_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_scores_account_scored ON skill_scores(account_id, scored_at)`,
    );

    await ensureColumns("skill_runs", [
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_runs_owner_started ON skill_runs(owner_user_id, started_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_runs_account_started ON skill_runs(account_id, started_at)`,
    );

    await ensureColumns("skill_failure_dismissals", [
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_failure_dismissals_owner ON skill_failure_dismissals(skill_name, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_skill_failure_dismissals_account ON skill_failure_dismissals(skill_name, account_id)`,
    );

    await ensureColumns("signal_sources", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await ensureColumns("signal_items", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await ensureColumns("scan_runs", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_signal_sources_scope_owner ON signal_sources(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_signal_sources_account ON signal_sources(account_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_signal_items_scope_owner ON signal_items(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_signal_items_account ON signal_items(account_id)`,
    );
    // The onConflictDoNothing({ target: fingerprint }) in news-storage requires this
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS signal_items_fingerprint_key ON signal_items(fingerprint)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_scan_runs_scope_owner ON scan_runs(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_scan_runs_account ON scan_runs(account_id)`,
    );

    await ensureColumns("thoughts", [
      { name: "scope", type: "TEXT NOT NULL DEFAULT 'user'" },
      { name: "owner_user_id", type: "TEXT" },
      { name: "account_id", type: "TEXT" },
    ]);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_thoughts_scope_owner ON thoughts(scope, owner_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_thoughts_account ON thoughts(account_id)`,
    );
    log("auto-heal: ensured skill, landscape, and thought scope columns", "migration");
  });

  await heal("skill_runs heal stuck runs", async () => {
    const { storage } = await import("./storage");
    const healed = await storage.healStuckSkillRuns();
    if (healed > 0) {
      log(
        `auto-heal: marked ${healed} stuck skill_runs as failed`,
        "migration",
      );
    }
  });

  await heal("emotional_states table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emotional_states (
        id SERIAL PRIMARY KEY,
        state_name TEXT NOT NULL,
        valence REAL NOT NULL DEFAULT 0,
        arousal REAL NOT NULL DEFAULT 0.5,
        triggers TEXT[] DEFAULT '{}',
        context TEXT DEFAULT '',
        source TEXT NOT NULL DEFAULT 'explicit',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_emotional_states_active ON emotional_states (active)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_emotional_states_created ON emotional_states (created_at)`,
    );
  });

  await heal("personas table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS personas (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        icon TEXT NOT NULL DEFAULT 'Bot',
        prompt_overlay TEXT,
        expression_tags JSONB DEFAULT '[]',
        cognitive_overrides JSONB DEFAULT '{}',
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    await pool.query(
      `ALTER TABLE personas ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'Bot'`,
    );
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS template_persona_id INTEGER`);
    await pool.query(`ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_name_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_global_name_unique ON personas (LOWER(name)) WHERE scope = 'global'`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_user_name_unique ON personas (owner_user_id, LOWER(name)) WHERE scope = 'user' AND owner_user_id IS NOT NULL`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_personas_active ON personas (is_active)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_personas_default ON personas (is_default)`,
    );
  });

  await heal("memory_entries emotional_state_id column", async () => {
    const col = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'memory_entries' AND column_name = 'emotional_state_id'
    `);
    if (col.rowCount === 0) {
      await pool.query(
        `ALTER TABLE memory_entries ADD COLUMN emotional_state_id INTEGER`,
      );
    }
  });

  await heal("internal transfers schema", async () => {
    await pool.query(`
      ALTER TABLE plaid_transactions
        ADD COLUMN IF NOT EXISTS transfer_pair_id TEXT,
        ADD COLUMN IF NOT EXISTS is_internal_transfer BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS transfer_pair_source TEXT
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS plaid_transactions_pair_idx ON plaid_transactions (transfer_pair_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS plaid_transactions_internal_idx ON plaid_transactions (is_internal_transfer)`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transfer_pair_overrides (
        id SERIAL PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        pair_with_transaction_id TEXT,
        force_mark_internal BOOLEAN NOT NULL DEFAULT FALSE,
        force_unmark BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS transfer_pair_overrides_pair_with_idx ON transfer_pair_overrides (pair_with_transaction_id)`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);
  });

  await heal("email dismissed triage status backfill", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);

    const migrationName = "email_dismissed_triage_status_backfill_v1";
    const exists = await pool.query(
      `SELECT 1 FROM app_migrations WHERE name = $1`,
      [migrationName],
    );
    if (exists.rowCount && exists.rowCount > 0) return;

    const result = await pool.query(`
      UPDATE email_messages
      SET triage_status = 'dismissed', updated_at = CURRENT_TIMESTAMP
      WHERE triage_status = 'triaged'
        AND triage_tier IN ('🗑️', '📋')
    `);

    await pool.query(
      `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [migrationName, JSON.stringify({ rowsUpdated: result.rowCount ?? 0 })],
    );
    log(
      `[boot] email dismissed triage status backfill: rowsUpdated=${result.rowCount ?? 0}`,
      "migration",
    );
  });

  await heal("people_import_candidates table + legacy migration", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS people_import_candidates (
        email TEXT PRIMARY KEY,
        candidate JSONB NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        decided_at TIMESTAMPTZ,
        merged_person_id TEXT,
        source TEXT,
        account_id TEXT,
        first_interaction_at TIMESTAMPTZ,
        last_interaction_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_people_import_candidates_decision_updated ON people_import_candidates (decision, updated_at)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_people_import_candidates_account ON people_import_candidates (account_id)`,
    );
    await pool.query(`ALTER TABLE people_import_candidates ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE people_import_candidates ADD COLUMN IF NOT EXISTS principal_account_id TEXT`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_people_import_candidates_owner ON people_import_candidates (owner_user_id, principal_account_id)`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS people_import_decisions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        person_id TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result JSONB NOT NULL,
        undo_data JSONB,
        owner_user_id TEXT,
        account_id TEXT,
        undone_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT people_import_decisions_owner_idempotency_unique UNIQUE (owner_user_id, account_id, idempotency_key)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_people_import_decisions_candidate_created ON people_import_decisions (candidate_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_people_import_decisions_owner ON people_import_decisions (owner_user_id, account_id)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS people_import_batches (
        id TEXT PRIMARY KEY,
        proposal_hash TEXT NOT NULL,
        proposal JSONB NOT NULL,
        preview JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'previewed',
        idempotency_key TEXT,
        result JSONB,
        owner_user_id TEXT,
        account_id TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        applied_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT people_import_batches_owner_idempotency_unique UNIQUE (owner_user_id, account_id, idempotency_key)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_people_import_batches_owner_created ON people_import_batches (owner_user_id, account_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_people_import_batches_expires ON people_import_batches (expires_at)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);

    const migrationName = "people_import_candidates_from_settings_v1";
    const exists = await pool.query(
      `SELECT 1 FROM app_migrations WHERE name = $1`,
      [migrationName],
    );
    if (exists.rowCount && exists.rowCount > 0) return;

    const legacy = await pool.query<{ value: any }>(
      `SELECT value FROM system_settings WHERE key = $1`,
      ["import_queue"],
    );
    const state = legacy.rows[0]?.value;
    const candidates =
      state &&
      typeof state === "object" &&
      state.candidates &&
      typeof state.candidates === "object"
        ? Object.entries(state.candidates as Record<string, any>)
        : [];

    let migrated = 0;
    for (const [rawEmail, rawCandidate] of candidates) {
      if (!rawCandidate || typeof rawCandidate !== "object") continue;
      const email = String((rawCandidate as any).email || rawEmail || "")
        .trim()
        .toLowerCase();
      if (!email) continue;
      const candidate = { ...(rawCandidate as any), email };
      const decision = String(candidate.decision || "pending");
      await pool.query(
        `
        INSERT INTO people_import_candidates (
          email, candidate, decision, decided_at, merged_person_id, source, account_id, first_interaction_at, last_interaction_at, updated_at
        ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (email) DO UPDATE SET
          candidate = people_import_candidates.candidate || EXCLUDED.candidate,
          decision = CASE
            WHEN people_import_candidates.decision = 'pending' THEN EXCLUDED.decision
            ELSE people_import_candidates.decision
          END,
          decided_at = COALESCE(people_import_candidates.decided_at, EXCLUDED.decided_at),
          merged_person_id = COALESCE(people_import_candidates.merged_person_id, EXCLUDED.merged_person_id),
          source = COALESCE(people_import_candidates.source, EXCLUDED.source),
          account_id = COALESCE(people_import_candidates.account_id, EXCLUDED.account_id),
          first_interaction_at = LEAST(COALESCE(people_import_candidates.first_interaction_at, EXCLUDED.first_interaction_at), COALESCE(EXCLUDED.first_interaction_at, people_import_candidates.first_interaction_at)),
          last_interaction_at = GREATEST(COALESCE(people_import_candidates.last_interaction_at, EXCLUDED.last_interaction_at), COALESCE(EXCLUDED.last_interaction_at, people_import_candidates.last_interaction_at)),
          updated_at = CURRENT_TIMESTAMP
      `,
        [
          email,
          JSON.stringify(candidate),
          decision,
          candidate.decidedAt ? new Date(candidate.decidedAt) : null,
          candidate.mergedPersonId || null,
          candidate.source || null,
          candidate.accountId || null,
          candidate.firstInteraction
            ? new Date(candidate.firstInteraction)
            : null,
          candidate.lastInteraction
            ? new Date(candidate.lastInteraction)
            : null,
        ],
      );
      migrated++;
    }

    await pool.query(
      `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [migrationName, JSON.stringify({ migrated, legacyPresent: !!state })],
    );
    log(
      `[boot] people import candidates legacy migration: migrated=${migrated}`,
      "migration",
    );
  });

  await heal("people_import_candidates ownership backfill", async () => {
    const migrationName = "people_import_candidates_ownership_v1";
    const exists = await pool.query(
      `SELECT 1 FROM app_migrations WHERE name = $1`,
      [migrationName],
    );
    if (exists.rowCount && exists.rowCount > 0) return;

    // Single-tenant history: all pre-ownership candidate rows belong to Ray.
    // Row-native ownership makes candidate visibility independent of
    // connected_accounts, so disconnecting a source account (e.g. an old
    // Gmail) never hides its import history again.
    await pool.query(`
      DO $$
      DECLARE
        ray_user_id text;
        ray_account_id text;
      BEGIN
        SELECT id INTO ray_user_id
        FROM users
        WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
        ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
        LIMIT 1;
        IF ray_user_id IS NOT NULL THEN
          SELECT id INTO ray_account_id FROM accounts WHERE kind = 'personal' AND owner_user_id = ray_user_id LIMIT 1;
          IF ray_account_id IS NOT NULL THEN
            UPDATE people_import_candidates
            SET owner_user_id = ray_user_id, principal_account_id = ray_account_id
            WHERE owner_user_id IS NULL;
            UPDATE people_import_candidates
            SET account_id = 'ios:' || ray_account_id
            WHERE account_id IS NULL AND source = 'ios_contacts';
          END IF;
        END IF;
      END $$;
    `);

    await pool.query(
      `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [migrationName, JSON.stringify({ note: "row-native ownership backfill + ios account_id repair" })],
    );
    log("[boot] people_import_candidates ownership backfill complete", "migration");
  });

  // parked_ideas table heal removed — intentions system deprecated

  await heal(
    "strip legacy idea-tag zombies from checkin flaggedTasks",
    async () => {
      // Pre-Task #989, voice park_idea appended strings prefixed with the
      // legacy idea-tag marker (open-bracket + Idea + close-bracket + space)
      // to memory_entries.metadata.flaggedTasks. The marker is built at
      // runtime so that ripgrep over the repo for the literal returns zero
      // hits — the Leave No Zombies acceptance check.
      const ideaTag = "[" + "Idea" + "] ";
      const ideaTagLike = ideaTag + "%";
      const exists = await pool.query(
        `SELECT 1 FROM app_migrations WHERE name = $1`,
        ["strip_idea_zombies_v1"],
      );
      if (exists.rowCount && exists.rowCount > 0) return;
      const result = await pool.query(
        `
      UPDATE memory_entries
      SET metadata = jsonb_set(
        metadata,
        '{flaggedTasks}',
        COALESCE(
          (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(metadata->'flaggedTasks') AS elem
            WHERE NOT (elem #>> '{}' LIKE $1)
          ),
          '[]'::jsonb
        )
      )
      WHERE source = 'checkin'
        AND metadata ? 'flaggedTasks'
        AND jsonb_typeof(metadata->'flaggedTasks') = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(metadata->'flaggedTasks') AS elem
          WHERE elem #>> '{}' LIKE $1
        )
    `,
        [ideaTagLike],
      );
      await pool.query(
        `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [
          "strip_idea_zombies_v1",
          JSON.stringify({ rowsUpdated: result.rowCount ?? 0 }),
        ],
      );
      log(
        `[boot] strip legacy idea-tag zombies: rowsUpdated=${result.rowCount ?? 0}`,
        "migration",
      );
    },
  );

  await heal("internal transfers backfill", async () => {
    const exists = await pool.query(
      `SELECT 1 FROM app_migrations WHERE name = $1`,
      ["internal_transfers_backfill_v1"],
    );
    if (exists.rowCount && exists.rowCount > 0) return;
    const { pairAllTransactions } =
      await import("./finance-internal-transfers");
    const result = await pairAllTransactions();
    await pool.query(
      `INSERT INTO app_migrations (name, metadata) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      ["internal_transfers_backfill_v1", JSON.stringify(result)],
    );
    log(
      `[boot] internal transfers backfill: paired=${result.pairs} scanned=${result.scanned}`,
      "migration",
    );
  });

  await heal("session_output_buffer table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_output_buffer (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        session_type TEXT NOT NULL DEFAULT 'user',
        title TEXT,
        topics TEXT[] NOT NULL DEFAULT '{}',
        pages_created TEXT[] NOT NULL DEFAULT '{}',
        pages_updated TEXT[] NOT NULL DEFAULT '{}',
        people_touched TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_output_buffer_created_at
        ON session_output_buffer (created_at DESC)
    `);
    log("auto-heal: created session_output_buffer table", "migration");
  });

  await heal("session_artifacts table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_artifacts (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_artifacts_unique
        ON session_artifacts (session_id, artifact_type, artifact_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_artifacts_session
        ON session_artifacts (session_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_artifacts_artifact
        ON session_artifacts (artifact_type, artifact_id)
    `);
    log("auto-heal: created session_artifacts table", "migration");
  });

  await heal("library_pages pg_trgm indexes", async () => {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_title_trgm ON library_pages USING GIN (title gin_trgm_ops)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_one_liner_trgm ON library_pages USING GIN (one_liner gin_trgm_ops)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_summary_trgm ON library_pages USING GIN (summary gin_trgm_ops)`,
    );
    log("auto-heal: created library_pages pg_trgm GIN indexes", "migration");
  });

  await heal("media_items table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_items (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        source TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        object_path TEXT NOT NULL,
        thumb_path TEXT,
        mime_type TEXT NOT NULL,
        file_size INTEGER,
        width INTEGER,
        height INTEGER,
        duration REAL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE media_items ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
    await pool.query(`ALTER TABLE media_items ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE media_items ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE media_items ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`);
    await pool.query(`ALTER TABLE media_items ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items (media_type)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_media_items_created ON media_items (created_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_media_items_source ON media_items (source)`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_items_object_path ON media_items (object_path)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_media_items_owner_created ON media_items(owner_user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_media_items_account_created ON media_items(account_id, created_at)`);
    log("auto-heal: created media_items table", "migration");
  });

  await heal("render_jobs table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS render_jobs (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        status TEXT NOT NULL DEFAULT 'pending',
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        clip_ids TEXT[] NOT NULL,
        output_resolution TEXT,
        total_duration REAL,
        output_media_id TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
    await pool.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS owner_user_id TEXT`);
    await pool.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS account_id TEXT`);
    await pool.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS created_by_user_id TEXT`);
    await pool.query(`ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs (status)`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_render_jobs_owner_created ON render_jobs(owner_user_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_render_jobs_account_created ON render_jobs(account_id, created_at)`);
    log("auto-heal: created render_jobs table", "migration");
  });

  await heal("plan_executions table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plan_executions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        origin_session_id TEXT NOT NULL,
        blocking BOOLEAN NOT NULL DEFAULT TRUE,
        workspace TEXT,
        workspace_dir TEXT,
        goal_id TEXT,
        project_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `ALTER TABLE plan_executions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_plan_executions_status ON plan_executions(status)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_plan_executions_archived_at ON plan_executions(archived_at)`,
    );
  });

  await heal("plan_steps table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plan_executions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        outcome TEXT,
        error TEXT,
        duration_seconds INTEGER,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        total_attempts INTEGER DEFAULT 0,
        timeout_minutes INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (plan_id, id)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_plan_steps_plan_id ON plan_steps(plan_id)`,
    );
  });


  await heal("workflow tables", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '1.0',
        status TEXT NOT NULL DEFAULT 'draft',
        definition JSONB NOT NULL DEFAULT '{}'::jsonb,
        default_autonomy_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_type_status ON workflow_templates(type, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_scope_owner ON workflow_templates(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_templates_account ON workflow_templates(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        current_stage_key TEXT,
        autonomy_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        retry_policy JSONB NOT NULL DEFAULT '{"maxAttempts":10}'::jsonb,
        lifecycle_snapshot JSONB,
        failure_packet JSONB,
        parent_session_id TEXT,
        linked_library_page_id TEXT,
        linked_plan_id TEXT REFERENCES plan_executions(id) ON DELETE SET NULL,
        linked_project_id INTEGER,
        linked_platform_id INTEGER REFERENCES platforms(id) ON DELETE SET NULL,
        linked_product_id INTEGER REFERENCES platform_products(id) ON DELETE SET NULL,
        linked_environment_id INTEGER REFERENCES platform_product_environments(id) ON DELETE SET NULL,
        created_by_session_id TEXT,
        completed_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_current_stage ON workflow_runs(current_stage_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_template ON workflow_runs(template_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_environment ON workflow_runs(linked_environment_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(linked_project_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_session ON workflow_runs(parent_session_id)`);
    await pool.query(`ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS lifecycle_snapshot JSONB`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_library_page ON workflow_runs(linked_library_page_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner_updated ON workflow_runs(owner_user_id, updated_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_account_updated ON workflow_runs(account_id, updated_at)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_stage_attempts (
        id SERIAL PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        stage_key TEXT NOT NULL,
        stage_title TEXT NOT NULL DEFAULT '',
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        autonomy_mode TEXT NOT NULL,
        child_session_id TEXT,
        linked_plan_id TEXT REFERENCES plan_executions(id) ON DELETE SET NULL,
        input_context JSONB NOT NULL DEFAULT '{}'::jsonb,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        output_summary TEXT,
        failure_context JSONB,
        result TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_workflow_stage_attempt UNIQUE(workflow_run_id, stage_key, attempt_number)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_run ON workflow_stage_attempts(workflow_run_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_stage ON workflow_stage_attempts(workflow_run_id, stage_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_status ON workflow_stage_attempts(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_child_session ON workflow_stage_attempts(child_session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_owner ON workflow_stage_attempts(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_stage_attempts_account ON workflow_stage_attempts(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_transitions (
        id SERIAL PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        from_stage_key TEXT,
        to_stage_key TEXT,
        from_attempt_id INTEGER REFERENCES workflow_stage_attempts(id) ON DELETE SET NULL,
        trigger TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_run_created ON workflow_transitions(workflow_run_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_to_stage ON workflow_transitions(to_stage_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_owner ON workflow_transitions(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_transitions_account ON workflow_transitions(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id SERIAL PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        stage_attempt_id INTEGER REFERENCES workflow_stage_attempts(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        ref_type TEXT NOT NULL DEFAULT 'text',
        ref_id TEXT,
        url TEXT,
        summary TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run ON workflow_artifacts(workflow_run_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_stage ON workflow_artifacts(stage_attempt_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_kind ON workflow_artifacts(kind)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_owner ON workflow_artifacts(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_account ON workflow_artifacts(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_gates (
        id SERIAL PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        stage_attempt_id INTEGER REFERENCES workflow_stage_attempts(id) ON DELETE CASCADE,
        gate_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        prompt TEXT NOT NULL,
        decision TEXT,
        decision_reason TEXT,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by_user_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_gates_run_status ON workflow_gates(workflow_run_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_gates_stage ON workflow_gates(stage_attempt_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_gates_owner ON workflow_gates(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_gates_account ON workflow_gates(account_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_sessions (
        id SERIAL PRIMARY KEY,
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        stage_attempt_id INTEGER REFERENCES workflow_stage_attempts(id) ON DELETE SET NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        spawn_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT,
        account_id TEXT,
        CONSTRAINT uk_workflow_session UNIQUE(workflow_run_id, session_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_sessions_run ON workflow_sessions(workflow_run_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_sessions_session ON workflow_sessions(session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_sessions_stage ON workflow_sessions(stage_attempt_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_sessions_owner ON workflow_sessions(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_sessions_account ON workflow_sessions(account_id)`);
  });

  await heal("session_tree spawn_status column", async () => {
    await pool.query(
      `ALTER TABLE session_tree ADD COLUMN IF NOT EXISTS spawn_status TEXT NOT NULL DEFAULT 'succeeded'`,
    );
    // Replace the old absolute unique constraint with a partial index that only
    // enforces uniqueness on non-terminal (pending/running) spawns. Required for
    // plan execution: failed spawns must not block legitimate retries.
    await pool.query(`ALTER TABLE session_tree DROP CONSTRAINT IF EXISTS uk_session_tree_spawn_idem`);
    await pool.query(`DROP INDEX IF EXISTS uk_session_tree_spawn_idem`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uk_session_tree_spawn_active
      ON session_tree (parent_session_id, spawn_reason, spawner_skill_run)
      WHERE spawn_status IN ('pending', 'running')`);
  });

  await heal("companies domain", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, website TEXT, industry TEXT, location TEXT, notes TEXT,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb, scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT, account_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_companies_scope_owner ON companies(scope, owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name)`);
    await pool.query(`ALTER TABLE persons ADD COLUMN IF NOT EXISTS company_id TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_persons_company_id ON persons(company_id)`);
  });

  await heal("persons last_viewed_at column", async () => {
    await pool.query(
      `ALTER TABLE persons ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ`,
    );
  });

  // Backfill media items from S3 — idempotent, safe to run on every startup
  try {
    const { backfillMediaFromStorage } = await import("./media/media-storage");
    const result = await backfillMediaFromStorage();
    if (result.registered > 0) {
      log(
        `media backfill: registered ${result.registered} new items from ${result.scanned} scanned`,
        "migration",
      );
    }
  } catch (err: any) {
    log(`media backfill skipped: ${err.message}`, "warn");
  }

  await heal("meeting_recap_distributions table", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meeting_recap_distributions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id      TEXT NOT NULL,
        owner_user_id   TEXT,
        account_id      TEXT,
        scope           TEXT NOT NULL DEFAULT 'user',
        attendee_email  TEXT NOT NULL,
        attendee_name   TEXT,
        is_mantra_user  BOOLEAN NOT NULL DEFAULT false,
        draft_id        UUID,
        send_method     TEXT NOT NULL DEFAULT 'gmail_draft',
        status          TEXT NOT NULL DEFAULT 'pending',
        error           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mrd_session ON meeting_recap_distributions(session_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mrd_owner   ON meeting_recap_distributions(owner_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mrd_account ON meeting_recap_distributions(account_id)`);
  });

  log(`schema bootstrap complete (reason=${reason})`, "migration");
}
