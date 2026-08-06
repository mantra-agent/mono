const MAX_STACK_FRAMES = 24;
const MAX_FILE_LENGTH = 240;
const MAX_SITE_LENGTH = 160;
const MAX_CODE_LENGTH = 48;
const MAX_NAME_LENGTH = 80;

const INFRASTRUCTURE_FRAMES = [
  "/client/src/lib/logger.",
  "/server/log.",
  "/server/error-telemetry.",
  "/server/telemetry-write.",
  "node:internal/",
  "/node_modules/",
];

const SECRET_LIKE =
  /(?:bearer\s+\S+|api[_-]?key|authorization|cookie|password|secret|token|session|email|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;

export interface SafeErrorCallsite {
  sourceFile?: string;
  sourceLine?: number;
  sourceSite?: string;
}

export interface SafeErrorClassifier {
  errorName?: string;
  errorCode?: string;
}

function normalizeFile(rawFile: string): string | undefined {
  const file = rawFile.replace(/\\/g, "/").replace(/[?#].*$/, "");
  if (!file || file.includes("..") || /(?:https?:|blob:|data:|@)/i.test(file)) return undefined;
  const sourceMarker = file.lastIndexOf("/src/");
  const serverMarker = file.lastIndexOf("/server/");
  const sharedMarker = file.lastIndexOf("/shared/");
  const marker = Math.max(sourceMarker, serverMarker, sharedMarker);
  const normalized =
    marker >= 0 ? file.slice(marker + 1) : file.split("/").filter(Boolean).slice(-2).join("/");
  return normalized && normalized.length <= MAX_FILE_LENGTH ? normalized : undefined;
}

function normalizeSite(rawSite: string | undefined): string | undefined {
  if (!rawSite) return undefined;
  const site = rawSite.replace(/^async\s+/, "").trim();
  return /^[A-Za-z0-9_.$<>:-]{1,160}$/.test(site) ? site.slice(0, MAX_SITE_LENGTH) : undefined;
}

function isInfrastructureFrame(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return INFRASTRUCTURE_FRAMES.some((frame) => normalized.includes(frame));
}

export function deriveSafeErrorCallsite(stack: string | undefined): SafeErrorCallsite {
  if (!stack) return {};
  const lines = stack.split("\n").slice(0, MAX_STACK_FRAMES);
  for (const line of lines) {
    const match =
      /^\s*at\s+(?:async\s+)?(?<site>.+?)\s+\((?<file>.*?):(?<line>\d+)(?::\d+)?\)$/.exec(line) ||
      /^\s*at\s+(?<file>.*?):(?<line>\d+)(?::\d+)?$/.exec(line) ||
      /^\s*at\s+(?:async\s+)?(?<site>[^\s]+)$/.exec(line);
    if (!match?.groups) continue;
    if (match.groups.file && isInfrastructureFrame(match.groups.file)) continue;
    const sourceFile = match.groups.file ? normalizeFile(match.groups.file) : undefined;
    if (sourceFile && isInfrastructureFrame(sourceFile)) continue;
    return {
      sourceFile,
      sourceLine: match.groups.line ? Number.parseInt(match.groups.line, 10) : undefined,
      sourceSite: normalizeSite(match.groups.site),
    };
  }
  return {};
}

function normalizeErrorName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)
    ? name.slice(0, MAX_NAME_LENGTH)
    : undefined;
}

function normalizeErrorCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const code = String(raw).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const compact = code.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(compact) ? compact.slice(0, MAX_CODE_LENGTH) : undefined;
}

function codeFromMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const trimmed = message.trim();
  if (!trimmed || SECRET_LIKE.test(trimmed)) return undefined;
  const tokens = trimmed
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && token.length <= 24)
    .slice(0, 4);
  if (tokens.length === 0) return undefined;
  return normalizeErrorCode(tokens.join("_"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Privacy-safe classifier for error aggregates.
 * Prefer explicit machine codes, then nested structured fields, then a short
 * tokenized log message. Never returns raw message/stack content.
 */
export function deriveSafeErrorClassifier(input: {
  message?: unknown;
  error?: unknown;
  args?: unknown[];
}): SafeErrorClassifier {
  const directError = input.error;
  const nestedFromArgs = (input.args ?? [])
    .map((arg) => asRecord(arg))
    .find(
      (arg) =>
        arg &&
        ("error" in arg ||
          "code" in arg ||
          "kind" in arg ||
          "name" in arg ||
          "errorCode" in arg ||
          "errorName" in arg ||
          "failureCode" in arg ||
          "failureKind" in arg),
    );
  const nestedError = asRecord(directError)?.error ?? nestedFromArgs?.error;
  const errorLike =
    directError instanceof Error
      ? directError
      : asRecord(directError) ?? asRecord(nestedError) ?? nestedFromArgs;

  const name =
    normalizeErrorName(
      errorLike instanceof Error
        ? errorLike.name
        : errorLike?.name ?? nestedFromArgs?.errorName ?? nestedFromArgs?.name,
    ) ?? "Error";

  const explicitCode = normalizeErrorCode(
    errorLike instanceof Error && "code" in errorLike
      ? (errorLike as Error & { code?: unknown }).code
      : errorLike?.code ??
        errorLike?.failureCode ??
        nestedFromArgs?.code ??
        nestedFromArgs?.failureCode ??
        nestedFromArgs?.errorCode ??
        errorLike?.kind ??
        errorLike?.failureKind ??
        nestedFromArgs?.kind ??
        nestedFromArgs?.failureKind,
  );

  const messageCode = codeFromMessage(input.message);
  const nestedMessageCode = codeFromMessage(
    errorLike instanceof Error ? errorLike.message : errorLike?.message,
  );

  return {
    errorName: name,
    errorCode: explicitCode ?? messageCode ?? nestedMessageCode,
  };
}
