import { access } from "fs/promises";
import { resolve } from "path";
import { WORKSPACE_DIR } from "./paths";

export async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export function resolveWorkspacePath(filePath: string): string | null {
  const sanitized = filePath.replace(/\\/g, "/").split("/").filter(p => p && p !== "." && p !== "..").join("/");
  if (!sanitized) return null;
  const resolved = resolve(WORKSPACE_DIR, sanitized);
  if (!resolved.startsWith(resolve(WORKSPACE_DIR) + "/")) return null;
  return resolved;
}
