import { resolve as resolvePath, dirname } from "path";
import { fileURLToPath } from "url";

function getDir(): string {
  try {
    if (typeof import.meta?.url === "string") {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {}
  return resolvePath(process.cwd(), "server");
}
const __dirname = getDir();

export function getGitCredentialEnv(token: string): Record<string, string> {
  return {
    GIT_ASKPASS: resolvePath(__dirname, "../scripts/git-askpass.sh"),
    GIT_USERNAME: "x-access-token",
    GIT_PASSWORD: token,
  };
}

export function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === "github.com" || parsed.host === "www.github.com";
  } catch {
    return url.includes("github.com");
  }
}
