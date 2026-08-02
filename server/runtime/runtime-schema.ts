import crypto from "crypto";
import type { Pool } from "pg";
import { DEFAULT_RUNTIME_CAPACITY_POLICY_V1 } from "./runtime-storage";

const MIGRATION_LOCK_KEY = "autonomy-runtime-kernel-v1";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

/** Additive, replay-safe runtime and shared outbox convergence. */
export async function ensureRuntimeKernelSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS runtime_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind TEXT NOT NULL,
        handler_key TEXT NOT NULL, handler_version INTEGER NOT NULL,
        source_type TEXT NOT NULL, source_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, causal_parent_run_id UUID,
        run_as_actor_type TEXT NOT NULL, run_as_subject_id TEXT NOT NULL,
        resource_pool TEXT NOT NULL, executor_profile TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL,
        deadline_at TIMESTAMPTZ NOT NULL, input_schema_version INTEGER NOT NULL,
        input JSONB NOT NULL, input_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        authority_policy_version_at_enqueue TEXT NOT NULL, budget JSONB NOT NULL,
        retry_policy JSONB NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT, outcome_reason_code TEXT, attribution TEXT,
        current_attempt_id UUID, receipt_event_id UUID,
        cancellation_requested_at TIMESTAMPTZ, cancellation_reason_code TEXT, terminal_at TIMESTAMPTZ,
        scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT runtime_runs_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT runtime_runs_handler_version_check CHECK (handler_version > 0 AND input_schema_version > 0),
        CONSTRAINT runtime_runs_priority_check CHECK (priority BETWEEN -100 AND 100),
        CONSTRAINT runtime_runs_deadline_check CHECK (deadline_at > created_at),
        CONSTRAINT runtime_runs_run_as_check CHECK (run_as_actor_type IN ('user','service')),
        CONSTRAINT runtime_runs_pool_check CHECK (resource_pool IN ('interactive_agent','background_agent','short_worker','isolated_execution')),
        CONSTRAINT runtime_runs_phase_check CHECK (phase IN ('pending','leased','running','terminal')),
        CONSTRAINT runtime_runs_outcome_check CHECK (outcome IS NULL OR outcome IN ('succeeded','degraded','blocked','failed','cancelled','needs_review')),
        CONSTRAINT runtime_runs_attribution_check CHECK (attribution IS NULL OR attribution IN ('runtime','provider','producer','handler','authority','external_dependency','user','system','unknown')),
        CONSTRAINT runtime_runs_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT runtime_runs_refs_check CHECK (jsonb_typeof(input_refs) = 'array' AND jsonb_array_length(input_refs) <= 100),
        CONSTRAINT runtime_runs_terminal_shape_check CHECK (
          (phase = 'terminal' AND outcome IS NOT NULL AND outcome_reason_code IS NOT NULL AND attribution IS NOT NULL AND receipt_event_id IS NOT NULL AND terminal_at IS NOT NULL)
          OR (phase <> 'terminal' AND outcome IS NULL AND outcome_reason_code IS NULL AND attribution IS NULL AND receipt_event_id IS NULL AND terminal_at IS NULL)
        ),
        CONSTRAINT runtime_runs_attempt_shape_check CHECK (
          (phase = 'pending' AND current_attempt_id IS NULL)
          OR (phase IN ('leased','running') AND current_attempt_id IS NOT NULL)
          OR phase = 'terminal'
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_account_kind_idempotency ON runtime_runs(account_id, kind, idempotency_key);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_account_id_unique ON runtime_runs(account_id, id);
      CREATE INDEX IF NOT EXISTS runtime_runs_dispatch_head ON runtime_runs(resource_pool, phase, available_at, account_id);
      CREATE INDEX IF NOT EXISTS runtime_runs_owner_created ON runtime_runs(owner_user_id, account_id, created_at);
      CREATE INDEX IF NOT EXISTS runtime_runs_parent ON runtime_runs(causal_parent_run_id);

      CREATE TABLE IF NOT EXISTS runtime_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL, account_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, resource_pool TEXT NOT NULL, lease_epoch INTEGER NOT NULL,
        lease_token_hash TEXT NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL,
        worker_id TEXT NOT NULL, executor_profile TEXT NOT NULL, capacity_policy_version INTEGER NOT NULL,
        phase TEXT NOT NULL DEFAULT 'leased', result TEXT, failure_class TEXT, reason_code TEXT,
        attribution TEXT, usage_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        leased_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMPTZ,
        last_heartbeat_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
        scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        CONSTRAINT runtime_attempts_run_account_fk FOREIGN KEY (account_id, run_id) REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT,
        CONSTRAINT runtime_attempts_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT runtime_attempts_number_check CHECK (attempt_number > 0 AND lease_epoch > 0),
        CONSTRAINT runtime_attempts_token_hash_check CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT runtime_attempts_pool_check CHECK (resource_pool IN ('interactive_agent','background_agent','short_worker','isolated_execution')),
        CONSTRAINT runtime_attempts_phase_check CHECK (phase IN ('leased','running','finished')),
        CONSTRAINT runtime_attempts_result_check CHECK (result IS NULL OR result IN ('completed','retry','lost','cancelled','blocked')),
        CONSTRAINT runtime_attempts_attribution_check CHECK (attribution IS NULL OR attribution IN ('runtime','provider','producer','handler','authority','external_dependency','user','system','unknown')),
        CONSTRAINT runtime_attempts_finished_shape_check CHECK (
          (phase = 'finished' AND result IS NOT NULL AND finished_at IS NOT NULL)
          OR (phase <> 'finished' AND result IS NULL AND finished_at IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_run_number_unique ON runtime_attempts(run_id, attempt_number);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_run_epoch_unique ON runtime_attempts(run_id, lease_epoch);
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_account_run_id_unique ON runtime_attempts(account_id, run_id, id);
      CREATE INDEX IF NOT EXISTS runtime_attempts_active_capacity ON runtime_attempts(resource_pool, phase, lease_expires_at);
      CREATE INDEX IF NOT EXISTS runtime_attempts_account_active ON runtime_attempts(account_id, resource_pool, phase, lease_expires_at);
      CREATE INDEX IF NOT EXISTS runtime_attempts_run_leased ON runtime_attempts(run_id, leased_at);

      CREATE TABLE IF NOT EXISTS runtime_run_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL, attempt_id UUID,
        account_id TEXT NOT NULL, event_type TEXT NOT NULL, reason_code TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb, payload_hash TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        CONSTRAINT runtime_run_events_run_account_fk FOREIGN KEY (account_id, run_id) REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT,
        CONSTRAINT runtime_run_events_attempt_fk FOREIGN KEY (account_id, run_id, attempt_id) REFERENCES runtime_attempts(account_id, run_id, id) ON DELETE RESTRICT,
        CONSTRAINT runtime_run_events_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT runtime_run_events_type_check CHECK (event_type IN ('authorization','mutation','verification','failure','correction','terminal_receipt')),
        CONSTRAINT runtime_run_events_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT runtime_run_events_payload_check CHECK (jsonb_typeof(payload) = 'object')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_events_terminal_receipt_unique ON runtime_run_events(run_id) WHERE event_type = 'terminal_receipt';
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_run_events_account_run_id_unique ON runtime_run_events(account_id, run_id, id);
      CREATE INDEX IF NOT EXISTS runtime_run_events_run_time ON runtime_run_events(run_id, occurred_at);
      CREATE INDEX IF NOT EXISTS runtime_run_events_attempt_time ON runtime_run_events(attempt_id, occurred_at);
      CREATE INDEX IF NOT EXISTS runtime_run_events_owner_time ON runtime_run_events(owner_user_id, account_id, occurred_at);

      CREATE TABLE IF NOT EXISTS runtime_capacity_policies (
        version INTEGER PRIMARY KEY, policy JSONB NOT NULL, policy_hash TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT runtime_capacity_policies_version_check CHECK (version > 0),
        CONSTRAINT runtime_capacity_policies_hash_check CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT runtime_capacity_policies_shape_check CHECK (jsonb_typeof(policy) = 'object')
      );

      CREATE TABLE IF NOT EXISTS transactional_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        payload JSONB NOT NULL, available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TIMESTAMPTZ, delivery_attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        scope TEXT NOT NULL DEFAULT 'user', owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT transactional_outbox_user_scope_check CHECK (scope = 'user'),
        CONSTRAINT transactional_outbox_event_type_check CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,119}$'),
        CONSTRAINT transactional_outbox_idempotency_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
        CONSTRAINT transactional_outbox_payload_check CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT transactional_outbox_attempts_check CHECK (delivery_attempts >= 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS transactional_outbox_owner_idempotency ON transactional_outbox(owner_user_id, account_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS transactional_outbox_ready ON transactional_outbox(published_at, available_at, created_at);
      CREATE INDEX IF NOT EXISTS transactional_outbox_aggregate ON transactional_outbox(account_id, aggregate_type, aggregate_id);
    `);

    await client.query(`
      ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS runtime_run_id UUID;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_runs_runtime_run_unique
        ON skill_runs(runtime_run_id) WHERE runtime_run_id IS NOT NULL;

      ALTER TABLE memory_vnext_source_queue ADD COLUMN IF NOT EXISTS runtime_run_id UUID;
      ALTER TABLE memory_vnext_source_queue ADD COLUMN IF NOT EXISTS runtime_source_version TIMESTAMPTZ;
      ALTER TABLE memory_vnext_source_queue ADD COLUMN IF NOT EXISTS runtime_attempt_id UUID;
      ALTER TABLE memory_vnext_source_queue ADD COLUMN IF NOT EXISTS runtime_lease_epoch INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vnext_source_queue_runtime_run_unique
        ON memory_vnext_source_queue(runtime_run_id) WHERE runtime_run_id IS NOT NULL;

      DO $runtime_domain_shape$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'memory_vnext_source_queue_runtime_fence_shape'
        ) THEN
          ALTER TABLE memory_vnext_source_queue
          ADD CONSTRAINT memory_vnext_source_queue_runtime_fence_shape CHECK (
            (runtime_run_id IS NULL AND runtime_source_version IS NULL AND runtime_attempt_id IS NULL AND runtime_lease_epoch IS NULL)
            OR (
              runtime_run_id IS NOT NULL AND runtime_source_version IS NOT NULL
              AND (
                (runtime_attempt_id IS NULL AND runtime_lease_epoch IS NULL)
                OR (runtime_attempt_id IS NOT NULL AND runtime_lease_epoch IS NOT NULL)
              )
            )
          );
        END IF;
      END
      $runtime_domain_shape$;
    `);

    const policyJson = JSON.stringify(DEFAULT_RUNTIME_CAPACITY_POLICY_V1);
    const policyHash = hashValue(DEFAULT_RUNTIME_CAPACITY_POLICY_V1);
    await client.query(
      `INSERT INTO runtime_capacity_policies(version, policy, policy_hash, created_by)
       VALUES ($1, $2::jsonb, $3, 'code:autonomy-runtime-kernel-v1')
       ON CONFLICT (version) DO NOTHING`,
      [DEFAULT_RUNTIME_CAPACITY_POLICY_V1.version, policyJson, policyHash],
    );
    const policyResult = await client.query(`SELECT policy_hash FROM runtime_capacity_policies WHERE version = $1`, [DEFAULT_RUNTIME_CAPACITY_POLICY_V1.version]);
    if (policyResult.rows[0]?.policy_hash !== policyHash) throw new Error("Runtime capacity policy v1 conflicts with the code-owned seed");

    await client.query(`DO $runtime_constraints$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_current_attempt_fk') THEN
          ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_current_attempt_fk
          FOREIGN KEY (account_id, id, current_attempt_id)
          REFERENCES runtime_attempts(account_id, run_id, id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_receipt_event_fk') THEN
          ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_receipt_event_fk
          FOREIGN KEY (account_id, id, receipt_event_id)
          REFERENCES runtime_run_events(account_id, run_id, id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runtime_runs_causal_parent_account_fk') THEN
          ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_causal_parent_account_fk
          FOREIGN KEY (account_id, causal_parent_run_id)
          REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_runs_runtime_run_account_fk') THEN
          ALTER TABLE skill_runs ADD CONSTRAINT skill_runs_runtime_run_account_fk
          FOREIGN KEY (account_id, runtime_run_id)
          REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_source_queue_runtime_run_account_fk') THEN
          ALTER TABLE memory_vnext_source_queue ADD CONSTRAINT memory_vnext_source_queue_runtime_run_account_fk
          FOREIGN KEY (account_id, runtime_run_id)
          REFERENCES runtime_runs(account_id, id) ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_source_queue_runtime_attempt_fence_fk') THEN
          ALTER TABLE memory_vnext_source_queue ADD CONSTRAINT memory_vnext_source_queue_runtime_attempt_fence_fk
          FOREIGN KEY (account_id, runtime_run_id, runtime_attempt_id)
          REFERENCES runtime_attempts(account_id, run_id, id) ON DELETE RESTRICT;
        END IF;
      END
    $runtime_constraints$`);
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_runtime_append_only_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
      END;
      $function$
    `);
    await client.query(`DROP TRIGGER IF EXISTS runtime_run_events_append_only ON runtime_run_events`);
    await client.query(`CREATE TRIGGER runtime_run_events_append_only BEFORE UPDATE OR DELETE ON runtime_run_events FOR EACH ROW EXECUTE FUNCTION prevent_runtime_append_only_mutation()`);
    await client.query(`DROP TRIGGER IF EXISTS runtime_capacity_policies_append_only ON runtime_capacity_policies`);
    await client.query(`CREATE TRIGGER runtime_capacity_policies_append_only BEFORE UPDATE OR DELETE ON runtime_capacity_policies FOR EACH ROW EXECUTE FUNCTION prevent_runtime_append_only_mutation()`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
