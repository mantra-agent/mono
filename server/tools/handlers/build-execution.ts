import type { ToolHandler } from "../contracts";
import { inputFailure, transientFailure } from "../../tool-failure";

/**
 * Build/operations execution handlers extracted from bridge-tools.ts.
 * These are the lowest-coupling Build-domain implementations (constrained
 * Python diagnostics and the bounded npm dependency mutation). They preserve
 * exact prior behavior, result shapes, and failure classification. Public
 * identity, authority, and dispatch composition remain owned by
 * tool-registry.ts, tools/domain-adapters.ts, and executeTool.
 */
export const buildExecutionHandlers: Readonly<Record<string, ToolHandler>> = {
  async python(args) {
    try {
      const { runConstrainedPython } = await import("../../python-runner");
      const run = await runConstrainedPython({
        repositoryDirectory: String(args.repositoryDirectory || ""),
        source: String(args.source || ""),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        sessionId: String(args._sessionId || ""),
      });
      const output = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join("\n");
      if (run.timedOut) {
        return {
          result: `Python execution timed out after ${run.durationMs}ms${output ? `\n${output}` : ""}`,
          error: true,
          failure: transientFailure("python_execution_timeout", `durationMs=${run.durationMs}`),
        };
      }
      if (run.outputLimitExceeded) {
        return {
          result: `Python execution exceeded the 256KB output limit${output ? `\n${output}` : ""}`,
          error: true,
          failure: inputFailure("python_output_limit_exceeded"),
        };
      }
      const header = run.exitCode === 0
        ? "Python execution completed"
        : `Python execution failed (exit ${run.exitCode ?? "?"}${run.signal ? `, signal ${run.signal}` : ""})`;
      return { result: `${header}${output ? `\n${output}` : ""}` };
    } catch (error) {
      return {
        result: `Python execution rejected: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
        failure: inputFailure("python_execution_rejected"),
      };
    }
  },

  async npm_dependencies(args) {
    if (args.action !== "set_package") {
      return { result: "Unknown npm_dependencies action. Available: set_package", error: true };
    }
    try {
      const { setNpmPackageSpec } = await import("../../npm-dependency-mutation");
      const result = await setNpmPackageSpec({
        repositoryDirectory: String(args.repositoryDirectory || ""),
        manifestPath: String(args.manifestPath || ""),
        section: args.section,
        packageName: String(args.packageName || ""),
        version: String(args.version || ""),
        sessionId: String(args._sessionId || ""),
      });
      return {
        result: JSON.stringify({
          ...result,
          safeCommand: `npm_dependencies(action=set_package, repositoryDirectory=${result.repositoryDirectory}, manifestPath=${result.manifestPath}, section=${result.section}, packageName=${result.packageName}, version=${result.version})`,
          npmContract: "npm install --package-lock-only --ignore-scripts --no-audit --no-fund --save-exact in the nested package directory with isolated HOME/cache and no node_modules present",
        }),
      };
    } catch (error) {
      return {
        result: `npm dependency mutation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      };
    }
  },
};
