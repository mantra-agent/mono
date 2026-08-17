/**
 * Person Work Ownership boot merge.
 * Additive column → map retired me|agent owner text onto cabinet Persons → NOT NULL → drop owner.
 * Idempotent. Fail closed when a cabinet Person cannot be resolved for an account that has work rows.
 */
import { createLogger } from "./log";

const log = createLogger("WorkOwnerSchema");
const LOCK_KEY = "migration.work-owner-person.v1";

type QueryResult = {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number | null;
};

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
};

async function columnExists(
  client: QueryableClient,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column],
  );
  return (result.rows?.length ?? 0) > 0;
}

async function tableExists(client: QueryableClient, table: string): Promise<boolean> {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`],
  );
  return result.rows?.[0]?.exists === true;
}

/**
 * Ensure owner_person_id on tasks/projects/milestones, boot-merge retired owner enum, drop owner columns.
 * Must run after persons + cabinet agent ensure and after milestones relation exists.
 */
export async function ensureWorkOwnerPersonSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))`);

    const hasTasks = await tableExists(client, "tasks");
    const hasProjects = await tableExists(client, "projects");
    const hasMilestones = await tableExists(client, "milestones");
    const hasPersons = await tableExists(client, "persons");

    if (!hasTasks || !hasProjects || !hasPersons) {
      log.log("work owner schema skipped — core tables missing");
      await client.query("COMMIT");
      return;
    }

    // 1. Additive columns
    if (!(await columnExists(client, "tasks", "owner_person_id"))) {
      await client.query(`ALTER TABLE tasks ADD COLUMN owner_person_id TEXT`);
      log.log("added tasks.owner_person_id");
    }
    if (!(await columnExists(client, "projects", "owner_person_id"))) {
      await client.query(`ALTER TABLE projects ADD COLUMN owner_person_id TEXT`);
      log.log("added projects.owner_person_id");
    }
    if (hasMilestones && !(await columnExists(client, "milestones", "owner_person_id"))) {
      await client.query(`ALTER TABLE milestones ADD COLUMN owner_person_id TEXT`);
      log.log("added milestones.owner_person_id");
    }

    // 2. Boot merge from retired owner text when that column still exists
    const tasksHaveOwner = await columnExists(client, "tasks", "owner");
    const projectsHaveOwner = await columnExists(client, "projects", "owner");

    if (tasksHaveOwner || projectsHaveOwner) {
      // Map agent → cabinet agent Person; everything else (me/blank/unexpected) → cabinet user Person.
      // Prefer account-scoped cabinet rows; fall back to owner_user_id match.
      if (projectsHaveOwner) {
        const projAgent = await client.query(`
          UPDATE projects p
          SET owner_person_id = cab.id
          FROM (
            SELECT DISTINCT ON (COALESCE(p2.account_id, ''), COALESCE(p2.owner_user_id, ''))
              p2.account_id,
              p2.owner_user_id,
              per.id
            FROM projects p2
            JOIN persons per ON per.cabinet_level = 'agent'
              AND (
                (p2.account_id IS NOT NULL AND per.account_id = p2.account_id)
                OR (p2.owner_user_id IS NOT NULL AND per.owner_user_id = p2.owner_user_id)
              )
            ORDER BY COALESCE(p2.account_id, ''), COALESCE(p2.owner_user_id, ''),
              CASE WHEN p2.account_id IS NOT NULL AND per.account_id = p2.account_id THEN 0 ELSE 1 END,
              per.created_at ASC NULLS LAST
          ) cab
          WHERE p.owner_person_id IS NULL
            AND LOWER(COALESCE(NULLIF(BTRIM(p.owner), ''), 'me')) = 'agent'
            AND (
              (p.account_id IS NOT NULL AND cab.account_id = p.account_id)
              OR (p.owner_user_id IS NOT NULL AND cab.owner_user_id = p.owner_user_id)
            )
        `);
        const projUser = await client.query(`
          UPDATE projects p
          SET owner_person_id = cab.id
          FROM (
            SELECT DISTINCT ON (COALESCE(p2.account_id, ''), COALESCE(p2.owner_user_id, ''))
              p2.account_id,
              p2.owner_user_id,
              per.id
            FROM projects p2
            JOIN persons per ON per.cabinet_level = 'user'
              AND (
                (p2.account_id IS NOT NULL AND per.account_id = p2.account_id)
                OR (p2.owner_user_id IS NOT NULL AND per.owner_user_id = p2.owner_user_id)
              )
            ORDER BY COALESCE(p2.account_id, ''), COALESCE(p2.owner_user_id, ''),
              CASE WHEN p2.account_id IS NOT NULL AND per.account_id = p2.account_id THEN 0 ELSE 1 END,
              per.created_at ASC NULLS LAST
          ) cab
          WHERE p.owner_person_id IS NULL
            AND (
              (p.account_id IS NOT NULL AND cab.account_id = p.account_id)
              OR (p.owner_user_id IS NOT NULL AND cab.owner_user_id = p.owner_user_id)
            )
        `);
        log.log(
          `projects owner merge agent=${projAgent.rowCount ?? 0} user=${projUser.rowCount ?? 0}`,
        );
      }

      if (tasksHaveOwner) {
        const taskAgent = await client.query(`
          UPDATE tasks t
          SET owner_person_id = cab.id
          FROM (
            SELECT DISTINCT ON (COALESCE(t2.account_id, ''), COALESCE(t2.owner_user_id, ''))
              t2.account_id,
              t2.owner_user_id,
              per.id
            FROM tasks t2
            JOIN persons per ON per.cabinet_level = 'agent'
              AND (
                (t2.account_id IS NOT NULL AND per.account_id = t2.account_id)
                OR (t2.owner_user_id IS NOT NULL AND per.owner_user_id = t2.owner_user_id)
              )
            ORDER BY COALESCE(t2.account_id, ''), COALESCE(t2.owner_user_id, ''),
              CASE WHEN t2.account_id IS NOT NULL AND per.account_id = t2.account_id THEN 0 ELSE 1 END,
              per.created_at ASC NULLS LAST
          ) cab
          WHERE t.owner_person_id IS NULL
            AND LOWER(COALESCE(NULLIF(BTRIM(t.owner), ''), 'me')) = 'agent'
            AND (
              (t.account_id IS NOT NULL AND cab.account_id = t.account_id)
              OR (t.owner_user_id IS NOT NULL AND cab.owner_user_id = t.owner_user_id)
            )
        `);
        const taskUser = await client.query(`
          UPDATE tasks t
          SET owner_person_id = cab.id
          FROM (
            SELECT DISTINCT ON (COALESCE(t2.account_id, ''), COALESCE(t2.owner_user_id, ''))
              t2.account_id,
              t2.owner_user_id,
              per.id
            FROM tasks t2
            JOIN persons per ON per.cabinet_level = 'user'
              AND (
                (t2.account_id IS NOT NULL AND per.account_id = t2.account_id)
                OR (t2.owner_user_id IS NOT NULL AND per.owner_user_id = t2.owner_user_id)
              )
            ORDER BY COALESCE(t2.account_id, ''), COALESCE(t2.owner_user_id, ''),
              CASE WHEN t2.account_id IS NOT NULL AND per.account_id = t2.account_id THEN 0 ELSE 1 END,
              per.created_at ASC NULLS LAST
          ) cab
          WHERE t.owner_person_id IS NULL
            AND (
              (t.account_id IS NOT NULL AND cab.account_id = t.account_id)
              OR (t.owner_user_id IS NOT NULL AND cab.owner_user_id = t.owner_user_id)
            )
        `);
        log.log(
          `tasks owner merge agent=${taskAgent.rowCount ?? 0} user=${taskUser.rowCount ?? 0}`,
        );
      }
    }

    // Milestones inherit parent project Person when unset
    if (hasMilestones) {
      const ms = await client.query(`
        UPDATE milestones m
        SET owner_person_id = p.owner_person_id
        FROM projects p
        WHERE m.project_id = p.id
          AND m.owner_person_id IS NULL
          AND p.owner_person_id IS NOT NULL
      `);
      log.log(`milestones inherited project owner count=${ms.rowCount ?? 0}`);
    }

    // Fail closed if any task/project still lacks owner_person_id
    const nullTasks = await client.query(
      `SELECT count(*)::int AS c FROM tasks WHERE owner_person_id IS NULL OR BTRIM(owner_person_id) = ''`,
    );
    const nullProjects = await client.query(
      `SELECT count(*)::int AS c FROM projects WHERE owner_person_id IS NULL OR BTRIM(owner_person_id) = ''`,
    );
    const taskNulls = Number(nullTasks.rows?.[0]?.c ?? 0);
    const projectNulls = Number(nullProjects.rows?.[0]?.c ?? 0);
    if (taskNulls > 0 || projectNulls > 0) {
      throw new Error(
        `work owner boot merge incomplete: tasks_null=${taskNulls} projects_null=${projectNulls}. Cabinet user/agent Persons must exist per account before owner enum drop.`,
      );
    }

    // 3. NOT NULL on tasks/projects
    await client.query(`ALTER TABLE tasks ALTER COLUMN owner_person_id SET NOT NULL`);
    await client.query(`ALTER TABLE projects ALTER COLUMN owner_person_id SET NOT NULL`);

    // Indexes (IF NOT EXISTS)
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_owner_person ON tasks (owner_person_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_owner_person ON projects (owner_person_id)`,
    );
    if (hasMilestones) {
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_milestones_owner_person ON milestones (owner_person_id)`,
      );
    }

    // 4. Drop retired owner columns
    if (tasksHaveOwner) {
      await client.query(`ALTER TABLE tasks DROP COLUMN owner`);
      log.log("dropped tasks.owner");
    }
    if (projectsHaveOwner) {
      await client.query(`ALTER TABLE projects DROP COLUMN owner`);
      log.log("dropped projects.owner");
    }

    await client.query("COMMIT");
    log.log("work owner person schema converged");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
