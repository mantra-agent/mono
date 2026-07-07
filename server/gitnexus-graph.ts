import { join, resolve as resolvePath } from "path";
import { existsSync } from "fs";
import { ensureBackend, bridgeCall } from "./gitnexus-bridge";
import type {
  GitNexusGraphNode,
  GitNexusGraphRelationship,
  GitNexusGraphResult,
  GitNexusArchitecture,
} from "./gitnexus-bridge";

function resolveGitnexusRuntimePath(subpath: string): string {
  const devCheck = resolvePath("node_modules/gitnexus");
  if (existsSync(devCheck)) {
    return `gitnexus/${subpath}`;
  }
  const prodPath = resolvePath(process.cwd(), `dist/gitnexus-runtime/gitnexus/${subpath}`);
  if (!existsSync(prodPath)) {
    throw new Error(`gitnexus runtime not found at ${prodPath} — was 'npm run build' executed?`);
  }
  return prodPath;
}

const NODE_TABLES = [
  "File", "Folder", "Function", "Class", "Interface", "Method",
  "CodeElement", "Community", "Process",
];

async function resolveRepoPaths(): Promise<{ repos: { storagePath: string; indexedAt?: string; [key: string]: unknown }[]; lbugPath: string }> {
  const { listRegisteredRepos } = await import(
    /* webpackIgnore: true */
    resolveGitnexusRuntimePath("dist/storage/repo-manager.js")
  );
  const repos = await listRegisteredRepos();
  if (!repos.length) throw new Error("No indexed repositories");
  const lbugPath = join(repos[0].storagePath, "lbug");
  return { repos, lbugPath };
}

function nodeTableQuery(table: string): string {
  if (table === "File" || table === "Folder")
    return `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  if (table === "Community")
    return `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
  if (table === "Process")
    return `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
  return `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
}

function rowToNode(row: Record<string, unknown>, table: string): GitNexusGraphNode {
  const s = (v: unknown) => (v != null ? String(v) : undefined);
  const n = (v: unknown) => (v != null ? Number(v) : undefined);
  return {
    id: String(row.id ?? row[0] ?? ""),
    label: table,
    properties: {
      name: String(row.name ?? row.label ?? row[1] ?? ""),
      filePath: s(row.filePath), startLine: n(row.startLine), endLine: n(row.endLine),
      heuristicLabel: s(row.heuristicLabel), cohesion: n(row.cohesion), symbolCount: n(row.symbolCount),
      processType: s(row.processType), stepCount: n(row.stepCount), communities: s(row.communities),
      entryPointId: s(row.entryPointId), terminalId: s(row.terminalId),
    },
  };
}

async function queryNodeTable(
  executeQuery: (q: string) => Promise<Record<string, unknown>[]>,
  table: string,
): Promise<GitNexusGraphNode[]> {
  const rows = await executeQuery(nodeTableQuery(table));
  return rows.map((row) => rowToNode(row, table));
}

async function queryRelationships(
  executeQuery: (q: string) => Promise<Record<string, unknown>[]>,
  limit: number,
): Promise<GitNexusGraphRelationship[]> {
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step LIMIT ${limit}`,
  );
  return relRows.map((row) => ({
    id: `${row.sourceId}_${row.type}_${row.targetId}`,
    type: String(row.type ?? ""),
    sourceId: String(row.sourceId ?? ""),
    targetId: String(row.targetId ?? ""),
    confidence: row.confidence != null ? Number(row.confidence) : undefined,
    reason: row.reason != null ? String(row.reason) : undefined,
    step: row.step != null ? Number(row.step) : undefined,
  }));
}

export async function getGraph(limit = 15_000): Promise<GitNexusGraphResult> {
  await ensureBackend();

  const { executeQuery, withLbugDb } = await import(
    /* webpackIgnore: true */
    resolveGitnexusRuntimePath("dist/core/lbug/lbug-adapter.js")
  );

  const { lbugPath } = await bridgeCall((_signal) => resolveRepoPaths(), "resolveRepoPaths()");

  return bridgeCall(
    (_signal) =>
      withLbugDb(lbugPath, async () => {
        const nodes: GitNexusGraphNode[] = [];
        for (const table of NODE_TABLES) {
          try {
            const tableNodes = await queryNodeTable(executeQuery, table);
            nodes.push(...tableNodes);
          } catch { /* table may not exist */ }
        }
        const relationships = await queryRelationships(executeQuery, limit);
        return { nodes, relationships };
      }),
    "getGraph()",
  );
}

export async function getArchitectureOverview(): Promise<GitNexusArchitecture> {
  const b = await ensureBackend();

  const [clustersResult, processesResult] = await Promise.all([
    bridgeCall((_signal) => b.queryClusters(undefined, 100), "queryClusters()"),
    bridgeCall((_signal) => b.queryProcesses(undefined, 100), "queryProcesses()"),
  ]);

  const context = b.getContext();
  const { clusters } = clustersResult;
  const { processes } = processesResult;

  return {
    context,
    clusters,
    processes,
    summary: {
      totalClusters: clusters.length,
      totalProcesses: processes.length,
      stats: (context as Record<string, unknown> | null)?.stats ?? null,
    },
  };
}

export async function getClusters(limit = 100): Promise<unknown> {
  const b = await ensureBackend();
  return bridgeCall((_signal) => b.queryClusters(undefined, limit), "getClusters()");
}

export async function getClusterDetail(name: string): Promise<unknown> {
  const b = await ensureBackend();
  return bridgeCall((_signal) => b.queryClusterDetail(name), `getClusterDetail(${name})`);
}

export async function getProcesses(limit = 100): Promise<unknown> {
  const b = await ensureBackend();
  return bridgeCall((_signal) => b.queryProcesses(undefined, limit), "getProcesses()");
}

export async function getProcessDetail(name: string): Promise<unknown> {
  const b = await ensureBackend();
  return bridgeCall((_signal) => b.queryProcessDetail(name), `getProcessDetail(${name})`);
}

export async function getCodebaseContext(): Promise<unknown> {
  const b = await ensureBackend();
  return await (bridgeCall as any)((_signal: any) => b.getContext(), "getCodebaseContext()");
}

export async function getGraphSchema(): Promise<string> {
  const { readResource } = await import(
    /* webpackIgnore: true */
    resolveGitnexusRuntimePath("dist/mcp/resources.js")
  );
  const b = await ensureBackend();
  return bridgeCall((_signal) => readResource("gitnexus://repo/workspace/schema", b), "getGraphSchema()");
}

export async function searchCode(query: string, limit = 10): Promise<unknown> {
  await ensureBackend();

  const { withLbugDb } = await import(
    /* webpackIgnore: true */
    resolveGitnexusRuntimePath("dist/core/lbug/lbug-adapter.js")
  );
  const { searchFTSFromLbug } = await import(
    /* webpackIgnore: true */
    resolveGitnexusRuntimePath("dist/core/search/bm25-index.js")
  );

  return bridgeCall(async (_signal) => {
    const { lbugPath } = await resolveRepoPaths();
    return withLbugDb(lbugPath, () => searchFTSFromLbug(query, limit));
  }, "searchCode()");
}
