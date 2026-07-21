import { existsSync } from "fs";
import { resolve as resolvePath } from "path";

const DEVELOPMENT_RUNTIME_ROOT = resolvePath(process.cwd(), "node_modules", "gitnexus");
const PRODUCTION_RUNTIME_ROOT = resolvePath(process.cwd(), "dist", "gitnexus-runtime", "gitnexus");

export type GitNexusRuntimeKind = "development" | "production";

export interface GitNexusRuntime {
  kind: GitNexusRuntimeKind;
  root: string;
  cliEntry: string;
}

function requireRuntime(kind: GitNexusRuntimeKind, root: string): GitNexusRuntime {
  const cliEntry = resolvePath(root, "dist", "cli", "index.js");
  if (!existsSync(cliEntry)) {
    throw new Error(`GitNexus ${kind} runtime missing CLI entry at ${cliEntry}`);
  }
  return { kind, root, cliEntry };
}

export function resolveGitNexusRuntime(): GitNexusRuntime {
  if (process.env.NODE_ENV === "production") {
    return requireRuntime("production", PRODUCTION_RUNTIME_ROOT);
  }
  if (existsSync(DEVELOPMENT_RUNTIME_ROOT)) {
    return requireRuntime("development", DEVELOPMENT_RUNTIME_ROOT);
  }
  return requireRuntime("production", PRODUCTION_RUNTIME_ROOT);
}

export function resolveGitNexusRuntimePath(subpath: string): string {
  return resolvePath(resolveGitNexusRuntime().root, subpath);
}
