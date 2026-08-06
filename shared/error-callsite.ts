const MAX_STACK_FRAMES = 24;
const MAX_FILE_LENGTH = 240;
const MAX_SITE_LENGTH = 160;

const INFRASTRUCTURE_FRAMES = [
  "/client/src/lib/logger.",
  "/server/log.",
  "/server/error-telemetry.",
  "/server/telemetry-write.",
  "node:internal/",
  "/node_modules/",
];

export interface SafeErrorCallsite {
  sourceFile?: string;
  sourceLine?: number;
  sourceSite?: string;
}

function normalizeFile(rawFile: string): string | undefined {
  const file = rawFile.replace(/\\/g, "/").replace(/[?#].*$/, "");
  if (!file || file.includes("..") || /(?:https?:|blob:|data:|@)/i.test(file)) return undefined;

  const sourceMarker = file.lastIndexOf("/src/");
  const serverMarker = file.lastIndexOf("/server/");
  const sharedMarker = file.lastIndexOf("/shared/");
  const marker = Math.max(sourceMarker, serverMarker, sharedMarker);
  const normalized = marker >= 0
    ? file.slice(marker + 1)
    : file.split("/").filter(Boolean).slice(-2).join("/");

  return normalized && normalized.length <= MAX_FILE_LENGTH ? normalized : undefined;
}

function normalizeSite(rawSite: string | undefined): string | undefined {
  if (!rawSite) return undefined;
  const site = rawSite.replace(/^async\s+/, "").trim();
  return /^[A-Za-z0-9_.$<>:-]{1,160}$/.test(site) && site.length <= MAX_SITE_LENGTH
    ? site
    : undefined;
}

export function deriveSafeErrorCallsite(stack: string | undefined): SafeErrorCallsite {
  if (!stack) return {};

  for (const frame of stack.split("\n").slice(1, MAX_STACK_FRAMES + 1)) {
    const match = frame.trim().match(/^at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!match) continue;

    const rawFile = match[2].replace(/\\/g, "/");
    if (INFRASTRUCTURE_FRAMES.some((fragment) => rawFile.includes(fragment))) continue;

    const sourceFile = normalizeFile(rawFile);
    const sourceLine = Number(match[3]);
    if (!sourceFile || !Number.isInteger(sourceLine) || sourceLine <= 0 || sourceLine > 10_000_000) continue;

    return {
      sourceFile,
      sourceLine,
      sourceSite: normalizeSite(match[1]),
    };
  }

  return {};
}
