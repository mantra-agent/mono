import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

function getServerDir(): string {
  try {
    if (typeof import.meta?.url === "string") {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
  }
  return resolve(process.cwd(), "server");
}

const _serverDir = getServerDir();

export const WORKSPACE_DIR = resolve(_serverDir, "..");
export const SESSIONS_DIR = resolve(_serverDir, "../agents/main/sessions");
