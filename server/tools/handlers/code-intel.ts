import type { ToolHandler } from "../contracts";
import { contractReject } from "../shared/failures";

async function gitnexusBridgeCall<T>(fn: () => Promise<T>): Promise<{ ok: boolean; result?: T; error?: string }> {
  try {
    const { isGitNexusReady, getStatus, getGitNexusPhase, startGitNexus } = await import("../../gitnexus-bridge");
    const status = await getStatus();
    if (status.phase === "disabled") {
      return { ok: false, error: "GitNexus indexing is disabled for the current Platform environments. Use normal repo/file inspection instead, or enable code indexing on the relevant environment source binding." };
    }
    if (!isGitNexusReady()) {
      // If indexing was never triggered in this process, warm it up now so the
      // first code action starts the index instead of failing forever on idle.
      // startGitNexus() guards against concurrent calls, so this is idempotent.
      if (getGitNexusPhase() === "idle") {
        startGitNexus().catch(() => {});
      }
      return { ok: false, error: status.message || "Index not ready — GitNexus is still indexing the codebase. Try again in a moment." };
    }
    const result = await fn();
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err.message || "GitNexus call failed" };
  }
}

/** Codebase knowledge-graph handlers (GitNexus). */
export const codeIntelTools: Record<string, ToolHandler> = {
  async code_query(args) {
    const query = args.query;
    if (!query) return contractReject("Missing query", "code_missing_query");

    const { searchCodebase } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => searchCodebase(query));
    if (!res.ok) return { result: res.error || "GitNexus query failed", error: true };

    const parsed = res.result;
    if (!parsed) return { result: "No results." };

    const lines: string[] = [];
    const procs: any[] = Array.isArray(parsed.processes) ? parsed.processes : [];
    const symbols: any[] = Array.isArray(parsed.process_symbols) ? parsed.process_symbols : [];
    const defs: any[] = Array.isArray(parsed.definitions) ? parsed.definitions : [];

    if (procs.length > 0) {
      lines.push(`**Processes (${procs.length}):**`);
      for (const p of procs) {
        lines.push(`- ${p.summary || p.label || p.id}${p.process_type ? ` [${p.process_type}]` : ""}${p.step_count != null ? `, ${p.step_count} steps` : ""}`);
      }
    }
    if (symbols.length > 0) {
      lines.push(`\n**Symbols (${symbols.length}):**`);
      for (const s of symbols) {
        let lineRange = "";
        if (s.startLine != null) {
          lineRange = s.endLine != null && s.endLine !== s.startLine
            ? ` line ${s.startLine}–${s.endLine}`
            : ` line ${s.startLine}`;
        }
        const loc = s.filePath ? ` — ${s.filePath}${lineRange}` : "";
        lines.push(`- [${s.type || "?"}] **${s.name}**${loc}`);
      }
    }
    if (defs.length > 0) {
      lines.push(`\n**Files & Definitions (${defs.length}):**`);
      for (const d of defs) {
        const loc = d.filePath ? ` — ${d.filePath}` : "";
        lines.push(`- [${d.type || "File"}] **${d.name || d.filePath}**${loc}`);
      }
    }
    if (lines.length === 0) {
      lines.push("No results found.");
    }
    return { result: lines.join("\n") };
  },

  async code_context(args) {
    const name = args.name;
    const uid = args.uid;
    if (!name && !uid) return { result: "Missing symbol name or uid", error: true };

    const params: Record<string, any> = {};
    if (name) params.name = name;
    if (uid) params.uid = uid;
    if (args.file) params.file_path = args.file;
    if (args.include_content != null) params.include_content = args.include_content;

    const { callTool } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("context", params));
    if (!res.ok) return { result: res.error || "GitNexus context lookup failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "Symbol not found." };
  },

  async code_impact(args) {
    const target = args.target;
    if (!target) return { result: "Missing target symbol name", error: true };

    const params: Record<string, any> = { target, direction: args.direction || "upstream" };
    if (args.maxDepth != null) params.maxDepth = args.maxDepth;
    if (args.includeTests != null) params.includeTests = args.includeTests;
    if (args.minConfidence != null) params.minConfidence = args.minConfidence;

    const { callTool } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("impact", params));
    if (!res.ok) return { result: res.error || "GitNexus impact analysis failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No impact data." };
  },

  async code_changes(_args) {
    const { callTool } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("detect_changes", {}));
    if (!res.ok) return { result: res.error || "GitNexus change detection failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No changes detected." };
  },

  async code_architecture(_args) {
    const { getArchitectureOverview } = await import("../../gitnexus-graph");
    const res = await gitnexusBridgeCall(() => getArchitectureOverview());
    if (!res.ok) return { result: res.error || "Architecture overview failed", error: true };
    return { result: JSON.stringify(res.result, null, 2) };
  },

  async code_modules(args) {
    const { getClusters, getClusterDetail } = await import("../../gitnexus-graph");
    if (args.name) {
      const res = await gitnexusBridgeCall(() => getClusterDetail(args.name));
      if (!res.ok) return { result: res.error || "Module query failed", error: true };
      return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
    }
    const res = await gitnexusBridgeCall(() => getClusters());
    if (!res.ok) return { result: res.error || "Module query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_flows(args) {
    const { getProcesses, getProcessDetail } = await import("../../gitnexus-graph");
    if (args.name) {
      const res = await gitnexusBridgeCall(() => getProcessDetail(args.name));
      if (!res.ok) return { result: res.error || "Flow query failed", error: true };
      return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
    }
    const res = await gitnexusBridgeCall(() => getProcesses());
    if (!res.ok) return { result: res.error || "Flow query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_rename(args) {
    const newName = args.new_name;
    if (!newName) return { result: "Missing new_name parameter", error: true };
    const params: Record<string, any> = { new_name: newName };
    if (args.symbol_name) params.symbol_name = args.symbol_name;
    if (args.symbol_uid) params.symbol_uid = args.symbol_uid;
    if (args.file_path) params.file_path = args.file_path;
    params.dry_run = args.dry_run !== false;
    const { callTool } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("rename", params));
    if (!res.ok) return { result: res.error || "Rename failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No rename results." };
  },

  async code_schema(_args) {
    const { getGraphSchema } = await import("../../gitnexus-graph");
    const res = await gitnexusBridgeCall(() => getGraphSchema());
    if (!res.ok) return { result: res.error || "Schema retrieval failed", error: true };
    return { result: typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2) };
  },

  async code_cypher(args) {
    const query = args.query;
    if (!query) return { result: "Missing Cypher query", error: true };
    const { callTool } = await import("../../gitnexus-bridge");
    const res = await gitnexusBridgeCall(() => callTool("cypher", { query }));
    if (!res.ok) return { result: res.error || "Cypher query failed", error: true };
    return { result: typeof res.result === "string" ? res.result : "No results." };
  },
};
