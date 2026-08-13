import { createHash } from "crypto";
import type { ClientBase } from "pg";

export const BACKUP_DISPOSITION_MANIFEST_VERSION = 7;

export type BackupClassification = "authoritative" | "control" | "projection" | "transient" | "retired" | "secret";
export type BackupSensitivity = "S0" | "S1" | "S2" | "S3";
export type BackupDisposition = {
  relation: string;
  action: "include" | "exclude";
  classification: BackupClassification;
  owner: string;
  reason: string;
  sensitivity: BackupSensitivity;
  recovery: string;
};

/**
 * Security denylist — the only authored membership surface.
 * Schema is membership: every declared/live relation exports unless listed here.
 * Retired, projection, and telemetry tables are NOT denylisted; they export if they exist.
 * These relations must never enter Brain restore (secrets, auth sessions, OAuth leases, active voice leases, device tokens).
 */
export type SecurityDenylistEntry = {
  owner: string;
  reason: string;
  classification: "secret" | "transient";
  sensitivity: BackupSensitivity;
  recovery: string;
};

export const SECURITY_DENYLIST: Record<string, SecurityDenylistEntry> = {
  app_secrets: {
    owner: "Security",
    reason: "Credential material requires separately envelope-encrypted recovery and must not enter Brain artifacts.",
    classification: "secret",
    sensitivity: "S3",
    recovery: "Reprovision or rotate through the secret owner; never restore from Brain.",
  },
  github_credentials: {
    owner: "Security",
    reason: "Repository credentials must not be copied into the ordinary logical backup blast radius.",
    classification: "secret",
    sensitivity: "S3",
    recovery: "Reprovision or rotate through the provider connection owner.",
  },
  glasses_device_tokens: {
    owner: "Glasses",
    reason: "Bearer device tokens authenticate a user and must not be copied into or revived from an ordinary Brain artifact.",
    classification: "secret",
    sensitivity: "S3",
    recovery: "Start empty and pair devices again to mint fresh tokens.",
  },
  session: {
    owner: "Authentication",
    reason: "Restoring browser sessions can resurrect authentication authority (connect-pg-simple).",
    classification: "transient",
    sensitivity: "S3",
    recovery: "Start empty and require reauthentication.",
  },
  google_oauth_transactions: {
    owner: "Integrations",
    reason: "Expiring PKCE/replay state is invalid and unsafe after recovery.",
    classification: "transient",
    sensitivity: "S3",
    recovery: "Start empty; users restart authorization.",
  },
  subscription_oauth_transactions: {
    owner: "Integrations",
    reason: "Expiring OAuth transaction state is invalid after recovery.",
    classification: "transient",
    sensitivity: "S3",
    recovery: "Start empty; users restart authorization.",
  },
  voice_session_active: {
    owner: "Voice",
    reason: "Active call leases are process/provider-time bound and restoring them blocks or resurrects calls.",
    classification: "transient",
    sensitivity: "S3",
    recovery: "Start empty and establish fresh leases.",
  },
};

export function isSecurityDenied(relation: string): boolean {
  return Object.prototype.hasOwnProperty.call(SECURITY_DENYLIST, relation);
}

export function listSecurityDenylistNames(): string[] {
  return Object.keys(SECURITY_DENYLIST).sort();
}

export type CatalogForeignKey = { name: string; parent: string; deferrable: boolean };
export type CatalogRelation = {
  name: string;
  oid: number;
  relkind: string;
  identityColumns: string[];
  sequenceColumns: Array<{ column: string; sequence: string }>;
  foreignKeys: CatalogForeignKey[];
};
export type BackupRestoreStrategy = {
  id:
    | "library-parent-reconciliation-v1"
    | "principle-current-revision-v1"
    | "runtime-reference-reconciliation-v1";
  relations: string[];
  insertOrder: string[];
  deferredConstraints: string[];
  reconciledReferences: string[];
};
export type BackupCoverage = {
  version: number;
  discovered: CatalogRelation[];
  included: BackupDisposition[];
  excluded: BackupDisposition[];
  insertOrder: string[];
  restoreStrategies: BackupRestoreStrategy[];
  schemaFingerprint: string;
  manifestFingerprint: string;
};

const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Schema is membership: non-denylisted relations export because they exist. */
function membershipDisposition(relation: string, leftover: boolean): BackupDisposition {
  return {
    relation,
    action: "include",
    classification: leftover ? "control" : "authoritative",
    owner: leftover ? "Core Recovery" : "Schema membership",
    reason: leftover
      ? "Live leftover not declared in source; exported via raw SQL under inverted default (schema is membership)."
      : "Schema is membership; relation exports because it exists.",
    sensitivity: "S2",
    recovery: "Restore rows and catalog-derived identity/sequence state.",
  };
}

/**
 * Reconcile live pg_catalog against the security denylist.
 * Membership = every ordinary relation minus SECURITY_DENYLIST.
 * Unexplained Live leftovers export (raw SQL at the producer layer) instead of failing for missing disposition.
 * Fail closed only for unsupported SCC / restore-contract drift (and caller-side denylist/producer checks).
 *
 * @param knownSourceRelations optional declared/source names used only to label leftovers in the manifest
 */
export async function inspectBackupCoverage(
  client: ClientBase,
  knownSourceRelations: string[] = [],
): Promise<BackupCoverage> {
  const result = await client.query<
    CatalogRelation & {
      identity_columns: string[] | null;
      sequence_columns: Array<{ column: string; sequence: string }> | null;
      foreign_keys: CatalogForeignKey[] | null;
    }
  >(`
    SELECT c.oid::int AS oid, c.relname AS name, c.relkind,
      COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attidentity <> ''), '[]') AS identity_columns,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('column', a.attname, 'sequence', pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL), '[]') AS sequence_columns,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', con.conname, 'parent', pc.relname, 'deferrable', con.condeferrable) ORDER BY con.conname) FROM pg_constraint con JOIN pg_class pc ON pc.oid=con.confrelid WHERE con.conrelid=c.oid AND con.contype='f'), '[]') AS foreign_keys
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND NOT c.relispartition
    ORDER BY c.relname`);
  const known = new Set(knownSourceRelations);
  const discovered = result.rows.map((row) => ({
    name: row.name,
    oid: row.oid,
    relkind: row.relkind,
    identityColumns: row.identity_columns ?? [],
    sequenceColumns: row.sequence_columns ?? [],
    foreignKeys: row.foreign_keys ?? [],
  }));

  const dispositions: BackupDisposition[] = discovered.map((rel) => {
    const denied = SECURITY_DENYLIST[rel.name];
    if (denied) {
      return {
        relation: rel.name,
        action: "exclude",
        classification: denied.classification,
        owner: denied.owner,
        reason: denied.reason,
        sensitivity: denied.sensitivity,
        recovery: denied.recovery,
      };
    }
    return membershipDisposition(rel.name, known.size > 0 ? !known.has(rel.name) : false);
  });

  // Denylist violation: a denylisted live relation must never be classified include.
  const denylistViolations = dispositions
    .filter((d) => d.action === "include" && isSecurityDenied(d.relation))
    .map((d) => d.relation);
  if (denylistViolations.length) {
    throw new Error(
      `Backup completeness preflight failed: security denylist violation — denylisted relation(s) would enter Brain: ${denylistViolations.join(", ")}`,
    );
  }

  const included = dispositions.filter((d) => d.action === "include");
  const excluded = dispositions.filter((d) => d.action === "exclude");
  const includedNames = new Set(included.map((d) => d.relation));
  const graph = new Map([...includedNames].map((name) => [name, [] as string[]]));
  for (const rel of discovered.filter((r) => includedNames.has(r.name))) {
    for (const fk of rel.foreignKeys) {
      if (includedNames.has(fk.parent)) graph.get(rel.name)!.push(fk.parent);
    }
  }
  const components = stronglyConnectedComponents(graph);
  const restoreStrategies = validateRestoreComponents(components, discovered);
  const componentByRelation = new Map(
    components.flatMap((component, index) => component.map((name) => [name, index] as const)),
  );
  const indegree = new Map(components.map((_, index) => [index, 0]));
  const children = new Map<number, Set<number>>();
  for (const [child, parents] of graph) {
    for (const parent of parents) {
      const childIndex = componentByRelation.get(child)!;
      const parentIndex = componentByRelation.get(parent)!;
      if (childIndex === parentIndex) continue;
      const next = children.get(parentIndex) ?? new Set<number>();
      if (!next.has(childIndex)) indegree.set(childIndex, indegree.get(childIndex)! + 1);
      next.add(childIndex);
      children.set(parentIndex, next);
    }
  }
  const queue = [...indegree]
    .filter(([, n]) => n === 0)
    .map(([index]) => index)
    .sort((a, b) => components[a][0].localeCompare(components[b][0]));
  const insertOrder: string[] = [];
  while (queue.length) {
    const index = queue.shift()!;
    const strategy = restoreStrategies.find((s) => s.relations.includes(components[index][0]));
    insertOrder.push(...(strategy?.insertOrder ?? components[index]));
    for (const child of children.get(index) ?? []) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
    queue.sort((a, b) => components[a][0].localeCompare(components[b][0]));
  }
  const schemaShape = discovered.map((r) => ({
    name: r.name,
    relkind: r.relkind,
    identityColumns: r.identityColumns,
    sequenceColumns: r.sequenceColumns,
    foreignKeys: r.foreignKeys,
  }));
  const manifestShape = [...included, ...excluded].sort((a, b) => a.relation.localeCompare(b.relation));
  return {
    version: BACKUP_DISPOSITION_MANIFEST_VERSION,
    discovered,
    included,
    excluded,
    insertOrder,
    restoreStrategies,
    schemaFingerprint: stableHash(schemaShape),
    manifestFingerprint: stableHash({ manifestShape, restoreStrategies }),
  };
}

function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  let i = 0;
  const indexes = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const out: string[][] = [];
  const visit = (name: string) => {
    indexes.set(name, i);
    low.set(name, i++);
    stack.push(name);
    active.add(name);
    for (const parent of graph.get(name) ?? []) {
      if (!indexes.has(parent)) {
        visit(parent);
        low.set(name, Math.min(low.get(name)!, low.get(parent)!));
      } else if (active.has(parent)) {
        low.set(name, Math.min(low.get(name)!, indexes.get(parent)!));
      }
    }
    if (low.get(name) !== indexes.get(name)) return;
    const part: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      part.push(member);
    } while (member !== name);
    out.push(part.sort());
  };
  for (const name of [...graph.keys()].sort()) if (!indexes.has(name)) visit(name);
  return out;
}

function validateRestoreComponents(
  components: string[][],
  discovered: CatalogRelation[],
): BackupRestoreStrategy[] {
  const byName = new Map(discovered.map((r) => [r.name, r]));
  const out: BackupRestoreStrategy[] = [];
  for (const component of components) {
    const self = component.flatMap((name) =>
      (byName.get(name)?.foreignKeys ?? []).filter((f) => f.parent === name),
    );
    if (component.length === 1 && self.length === 0) continue;
    const signature = component.join(",");
    if (signature === "library_pages") {
      if (self.length !== 1 || self[0].deferrable) {
        throw new Error(
          "Backup completeness preflight failed: library_pages parent self-reference restore contract drifted",
        );
      }
      out.push({
        id: "library-parent-reconciliation-v1",
        relations: component,
        insertOrder: ["library_pages"],
        deferredConstraints: [],
        reconciledReferences: ["library_pages.parent_id"],
      });
      continue;
    }
    if (signature === "principle_revisions,principles") {
      out.push({
        id: "principle-current-revision-v1",
        relations: component,
        insertOrder: ["principles", "principle_revisions"],
        deferredConstraints: requireDeferrable(byName, "principles", "principle_revisions"),
        reconciledReferences: [],
      });
      continue;
    }
    if (signature === "runtime_attempts,runtime_run_events,runtime_runs") {
      const causal = (byName.get("runtime_runs")?.foreignKeys ?? []).filter(
        (f) => f.parent === "runtime_runs" && !f.deferrable,
      );
      if (causal.length !== 1) {
        throw new Error(
          "Backup completeness preflight failed: runtime self-reference restore contract drifted",
        );
      }
      out.push({
        id: "runtime-reference-reconciliation-v1",
        relations: component,
        insertOrder: ["runtime_runs", "runtime_attempts", "runtime_run_events"],
        deferredConstraints: [
          ...requireDeferrable(byName, "runtime_runs", "runtime_attempts"),
          ...requireDeferrable(byName, "runtime_runs", "runtime_run_events"),
        ].sort(),
        reconciledReferences: ["runtime_runs.causal_parent_run_id"],
      });
      continue;
    }
    throw new Error(
      `Backup completeness preflight failed: unsupported FK strongly connected component: ${component.join(" <-> ")}`,
    );
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function requireDeferrable(
  byName: Map<string, CatalogRelation>,
  child: string,
  parent: string,
): string[] {
  const matches = (byName.get(child)?.foreignKeys ?? []).filter((f) => f.parent === parent);
  if (!matches.length || matches.some((f) => !f.deferrable)) {
    throw new Error(
      `Backup completeness preflight failed: ${child}->${parent} must be deferrable for its declared restore strategy`,
    );
  }
  return matches.map((f) => `${child}.${f.name}`);
}
