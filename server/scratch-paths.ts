import { realpath } from "fs/promises";
import { basename, dirname, relative, resolve, sep } from "path";
import { resolveWorkspacePath } from "./fs-utils";
import { WORKSPACE_DIR } from "./paths";

/**
 * Resolve the canonical file identity used by scratch reads and recovery policy.
 * Existing files are realpathed so aliases and symlinks cannot split one resource
 * into multiple recovery ledgers.
 */
export async function resolveScratchResourcePath(filePath: string): Promise<string | null> {
  const resolved = resolveWorkspacePath(filePath);
  if (!resolved) return null;

  try {
    const [canonicalWorkspace, canonicalResource] = await Promise.all([
      realpath(WORKSPACE_DIR),
      realpath(resolved),
    ]);
    const boundary = canonicalWorkspace.endsWith(sep) ? canonicalWorkspace : `${canonicalWorkspace}${sep}`;
    return canonicalResource === canonicalWorkspace || canonicalResource.startsWith(boundary)
      ? canonicalResource
      : null;
  } catch (error: any) {
    return error?.code === "ENOENT" ? resolved : null;
  }
}

/**
 * Resolve a writable path only when it belongs to the current session's isolated
 * repository clone or the session's user-facing files directory.
 */
export async function resolveScratchWritePath(filePath: string, sessionId: unknown): Promise<string | null> {
  if (typeof sessionId !== "string" || sessionId.length < 8) return null;
  const resolved = resolveWorkspacePath(filePath);
  if (!resolved) return null;

  const filesRoot = resolve(WORKSPACE_DIR, "files");
  const relativeToFiles = relative(filesRoot, resolved);
  if (relativeToFiles === "" || (!relativeToFiles.startsWith("..") && !relativeToFiles.startsWith("/"))) {
    return resolved;
  }

  const reposRoot = resolve(WORKSPACE_DIR, "repos");
  const relativeToRepos = relative(reposRoot, resolved);
  if (relativeToRepos.startsWith("..") || relativeToRepos.startsWith("/") || relativeToRepos === "") return null;

  const repositoryDirectory = relativeToRepos.split(/[\\/]/)[0];
  if (typeof sessionId !== "string" || !repositoryDirectory.endsWith(`-${sessionId.slice(0, 8)}`)) return null;

  const repositoryRoot = await realpath(resolve(reposRoot, repositoryDirectory)).catch(() => null);
  if (!repositoryRoot) return null;

  let existingAncestor = resolved;
  while (existingAncestor !== dirname(existingAncestor)) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      const boundary = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
      return canonicalAncestor === repositoryRoot || canonicalAncestor.startsWith(boundary) ? resolved : null;
    } catch (error: any) {
      if (error?.code !== "ENOENT") return null;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return null;
      existingAncestor = parent;
    }
  }
  return null;
}

export function scratchResourceKey(resolvedPath: string): string {
  return `file:${resolvedPath}`;
}

export function scratchResourceLabel(resourceKey: string): string {
  return basename(resourceKey.slice("file:".length)) || resourceKey;
}
