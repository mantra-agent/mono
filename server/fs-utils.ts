import { access } from "fs/promises";
import { resolve } from "path";
import { WORKSPACE_DIR } from "./paths";

export async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export function resolveWorkspacePath(filePath: string): string | null {
  // Empty / "." / "./" means the workspace root itself (list default).
  // Strip only ".." segments and empty parts; keep legitimate relative paths.
  const sanitized = filePath.replace(/\\/g, "/").split("/").filter(p => p && p !== "." && p !== "..").join("/");
  const workspaceRoot = resolve(WORKSPACE_DIR);
  if (!sanitized) return workspaceRoot;
  const resolved = resolve(WORKSPACE_DIR, sanitized);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + "/")) return null;
  return resolved;
}
