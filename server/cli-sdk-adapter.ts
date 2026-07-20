import { z } from "zod";
import path from "path";
import fs from "fs";
import { existsSync } from "fs";
import crypto from "crypto";
import type { ToolDefinition } from "@shared/models/tools";
import type { StreamEvent, ChatCompletionStreamOptions, ChatCompletionOptions, ChatCompletionResult } from "./model-client";
import type { ToolExecutor } from "./agent-executor";
import type { ClaudeCliTierModelConfig } from "@shared/model-connectors";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "./log";
import { getModel } from "./model-registry";
import { getSecretSync } from "./secrets-store";
import { thinkingConfigKey } from "./thinking-config";

const log = createLogger("cli-sdk-adapter");

function resolvedClaudeCliConfig(options: Pick<ChatCompletionOptions, "routingDecision">): ClaudeCliTierModelConfig | undefined {
  return options.routingDecision?.provider === "claude-cli"
    ? options.routingDecision.modelConfig as ClaudeCliTierModelConfig | undefined
    : undefined;
}

// Hoist SDK module load out of the per-call hot path. The dynamic import is fired the first
// time this module is evaluated; subsequent `cliSdkStream` calls just `await` an already-
// resolved promise (≈0ms) instead of re-entering Node's module loader. This kills a
// previously-observed `pre_sdk` cost on the first turn after boot and trims microtask
// overhead on every subsequent turn.
type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");
const sdkModulePromise: Promise<SdkModule> = import("@anthropic-ai/claude-agent-sdk");
sdkModulePromise.catch((err) => {
  log.warn(`cliSdkStream: SDK module preload failed (will retry on first call): ${err instanceof Error ? err.message : String(err)}`);
});

// =====================================================================
// Subprocess crash instrumentation (Task #1045).
//
// The SDK throws a generic `Error("Claude Code process exited with code N")`
// without exposing the subprocess's stderr, the actual exit code/signal, or
// the runtime path it tried to spawn. To diagnose Railway-only crashes we
// capture stderr via the SDK's `stderr` callback into a per-call rolling
// buffer and emit a single greppable `cli_subprocess_crash` line on every
// failure. Grep for `cli_subprocess_crash` in Railway logs.
// =====================================================================
type StderrRef = { tail: string };
const STDERR_TAIL_CAP = 8 * 1024;

function appendStderrTail(ref: StderrRef, chunk: string): void {
  if (!chunk) return;
  ref.tail += chunk;
  if (ref.tail.length > STDERR_TAIL_CAP) {
    ref.tail = ref.tail.slice(ref.tail.length - STDERR_TAIL_CAP);
  }
}

function escapeForLogLine(s: string): string {
  // Single-line escape: collapse newlines/tabs and strip control chars so the
  // crash line stays grep-friendly in Railway's line-oriented log viewer.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "?");
}

function tokenFingerprint(token: string | undefined | null): string {
  if (!token) return "n/a";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function parseExitCodeAndSignal(raw: string): { exitCode: number | null; signal: string | null } {
  let exitCode: number | null = null;
  let signal: string | null = null;
  const codeMatch = raw.match(/code\s+(-?\d+)/i);
  if (codeMatch) {
    const n = parseInt(codeMatch[1], 10);
    if (!isNaN(n)) exitCode = n;
  }
  const signalMatch = raw.match(/signal\s+([A-Z0-9]+)/i);
  if (signalMatch) signal = signalMatch[1];
  return { exitCode, signal };
}

function resolveDeclaredClaudeBin(packageDir: string): string | null {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const declaredBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.claude;
    if (!declaredBin || declaredBin.includes("..")) return null;
    const candidate = path.resolve(packageDir, declaredBin);
    return candidate.startsWith(`${path.resolve(packageDir)}${path.sep}`) && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveCliPath(): string {
  // Package bin metadata is the executable contract. Claude Code 2.1.216
  // moved from cli.js to bin/claude.exe, while older installations retain
  // cli.js. Resolve the declared entry in the bundled runtime first, then
  // the development node_modules copy.
  const packageRoots = [
    path.resolve(process.cwd(), "dist", "claude-cli-runtime", "node_modules", "@anthropic-ai", "claude-code"),
    path.resolve(process.cwd(), "node_modules", "@anthropic-ai", "claude-code"),
  ];
  for (const packageRoot of packageRoots) {
    const declared = resolveDeclaredClaudeBin(packageRoot);
    if (declared) return declared;
  }
  return path.resolve(packageRoots[0], "bin", "claude.exe");
}


export interface CliRuntimeProbe {
  cliPath: string;
  cliPathExists: boolean;
  cliPathSizeBytes: number | null;
  runtimeDirFileCount: number | null;
  runtimeDirTotalBytes: number | null;
  nodeVersion: string;
  cwd: string;
  nodeEnv: string;
  oauthTokenPresent: boolean;
  oauthTokenLen: number;
  oauthTokenFp: string;
  warmPoolSize: number;
}

export function probeCliRuntime(): CliRuntimeProbe {
  const cliPath = resolveCliPath();
  let cliPathExists = false;
  let cliPathSizeBytes: number | null = null;
  let runtimeDirFileCount: number | null = null;
  let runtimeDirTotalBytes: number | null = null;
  try {
    const st = fs.statSync(cliPath);
    cliPathExists = true;
    cliPathSizeBytes = st.size;
  } catch { /* ignore */ }
  // Runtime dir = parent of the declared CLI entry. Bounded
  // depth-1 listing only — never recurse — so this stays O(1) at boot.
  try {
    const runtimeDir = path.dirname(cliPath);
    const entries = fs.readdirSync(runtimeDir);
    let count = 0;
    let bytes = 0;
    for (const name of entries) {
      try {
        const st = fs.statSync(path.join(runtimeDir, name));
        if (st.isFile()) {
          count++;
          bytes += st.size;
        } else if (st.isDirectory()) {
          // Count the directory entry itself but don't recurse.
          count++;
        }
      } catch { /* skip unreadable */ }
    }
    runtimeDirFileCount = count;
    runtimeDirTotalBytes = bytes;
  } catch { /* ignore */ }
  const token = getSecretSync("CLAUDE_CODE_OAUTH_TOKEN") || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    cliPath,
    cliPathExists,
    cliPathSizeBytes,
    runtimeDirFileCount,
    runtimeDirTotalBytes,
    nodeVersion: process.version,
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV || "development",
    oauthTokenPresent: !!token,
    oauthTokenLen: token ? token.length : 0,
    oauthTokenFp: tokenFingerprint(token),
    warmPoolSize: WARM_POOL_SIZE,
  };
}

export type CliCrashPhase =
  | "pre_first_event"
  | "post_first_event"
  | "during_tool_loop"
  | "warm_refill"
  | "result_error"
  | "thrown";

export interface CliCrashContext {
  phase: CliCrashPhase;
  model: string;
  rawError: string;
  runId?: string | null;
  convId?: string | null;
  pooledHit?: boolean | null;
  poolEligible?: boolean | null;
  workerAgeMs?: number | null;
  elapsedMs?: number | null;
  eventsReceived?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  stderrTail?: string | null;
}

type ClaudeCliTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  source: string;
};

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeClaudeCliUsage(raw: unknown, source: string): ClaudeCliTokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const inputTokens = numberField(usage.input_tokens) ?? numberField(usage.inputTokens);
  const outputTokens = numberField(usage.output_tokens) ?? numberField(usage.outputTokens);
  const cacheReadTokens = numberField(usage.cache_read_input_tokens) ?? numberField(usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens = numberField(usage.cache_creation_input_tokens) ?? numberField(usage.cacheWriteTokens) ?? 0;
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    source,
  };
}

function normalizeClaudeCliModelUsage(raw: unknown): ClaudeCliTokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  let total: ClaudeCliTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: "result.modelUsage" };
  let sawUsage = false;
  for (const usage of Object.values(raw as Record<string, unknown>)) {
    const normalized = normalizeClaudeCliUsage(usage, "result.modelUsage");
    if (!normalized) continue;
    sawUsage = true;
    total = {
      ...total,
      inputTokens: total.inputTokens + normalized.inputTokens,
      outputTokens: total.outputTokens + normalized.outputTokens,
      cacheReadTokens: total.cacheReadTokens + normalized.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + normalized.cacheWriteTokens,
    };
  }
  return sawUsage ? total : null;
}

function applyClaudeCliUsage(usage: ClaudeCliTokenUsage): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

export function emitCliSubprocessCrash(ctx: CliCrashContext): void {
  const probe = probeCliRuntime();
  const { exitCode, signal } = parseExitCodeAndSignal(ctx.rawError || "");
  const modelInfo = getModel(ctx.model);
  const cliModel = modelInfo?.claudeModelId || ctx.model;
  const tail = ctx.stderrTail ? escapeForLogLine(ctx.stderrTail) : "";
  const raw = escapeForLogLine((ctx.rawError || "").slice(0, 4096));
  const parts: string[] = [
    `cli_subprocess_crash`,
    `phase=${ctx.phase}`,
    `model=${ctx.model}`,
    `cliModel=${cliModel}`,
    `runId=${ctx.runId ?? "null"}`,
    `convId=${ctx.convId ?? "null"}`,
    `exitCode=${exitCode ?? "null"}`,
    `signal=${signal ?? "null"}`,
    `pooledHit=${ctx.pooledHit ?? "null"}`,
    `poolEligible=${ctx.poolEligible ?? "null"}`,
    `worker_age_ms=${ctx.workerAgeMs ?? "null"}`,
    `elapsed_ms=${ctx.elapsedMs ?? "null"}`,
    `events_received=${ctx.eventsReceived ?? "null"}`,
    `tokens_in=${ctx.inputTokens ?? "null"}`,
    `tokens_out=${ctx.outputTokens ?? "null"}`,
    `oauth_token_present=${probe.oauthTokenPresent}`,
    `oauth_token_len=${probe.oauthTokenLen}`,
    `oauth_token_fp=${probe.oauthTokenFp}`,
    `cli_path=${probe.cliPath}`,
    `cli_path_exists=${probe.cliPathExists}`,
    `cli_path_size_bytes=${probe.cliPathSizeBytes ?? "null"}`,
    `node_version=${probe.nodeVersion}`,
    `cwd=${probe.cwd}`,
    `node_env=${probe.nodeEnv}`,
    `subprocess_stderr_tail="${tail}"`,
    `last_sdk_error_raw="${raw}"`,
  ];
  log.error(parts.join(" "));
}

function friendlyCliError(raw: string, model: string): string {
  const modelInfo = getModel(model);
  const cliModel = modelInfo?.claudeModelId || model;
  const displayName = modelInfo?.name || model;
  const looksLikeUnknownModel =
    /Run\s+--model\s+to pick a different model/i.test(raw) ||
    /may not exist or you may not have access/i.test(raw) ||
    /There['’]s an issue with the selected model/i.test(raw) ||
    /Invalid model/i.test(raw) ||
    /model.*not (?:found|available)/i.test(raw);
  if (looksLikeUnknownModel) {
    return `The selected model "${displayName}" (${cliModel}) isn't available on your Claude subscription right now. Please pick a different model in Settings (e.g. Claude Opus 4.6 Subscription, or the generic Claude Opus/Sonnet Subscription aliases).`;
  }
  return raw.slice(0, 500);
}

let activeZombieCount = 0;
let peakZombieCount = 0;

export function getZombieMetrics() {
  return { active: activeZombieCount, peak: peakZombieCount };
}

export function resetZombiePeakCount() {
  peakZombieCount = activeZombieCount;
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string | undefined;
  const desc = prop.description as string | undefined;

  let schema: z.ZodTypeAny;

  switch (type) {
    case "string": {
      if (prop.enum && Array.isArray(prop.enum)) {
        schema = z.enum(prop.enum as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    }
    case "number":
    case "integer":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      schema = items ? z.array(jsonSchemaPropertyToZod(items)) : z.array(z.unknown());
      break;
    }
    case "object": {
      const nestedProps = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (nestedProps) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const nestedRequired = new Set((prop.required as string[]) || []);
        for (const [k, v] of Object.entries(nestedProps)) {
          shape[k] = nestedRequired.has(k) ? jsonSchemaPropertyToZod(v) : jsonSchemaPropertyToZod(v).optional();
        }
        schema = z.object(shape);
      } else {
        schema = z.record(z.unknown());
      }
      break;
    }
    default:
      schema = z.unknown();
  }

  if (desc) {
    schema = schema.describe(desc);
  }

  return schema;
}

function toolDefToZodShape(def: ToolDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(def.parameters.required || []);

  for (const [key, prop] of Object.entries(def.parameters.properties)) {
    const propObj = prop as Record<string, unknown>;
    const zodType = jsonSchemaPropertyToZod(propObj);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }

  return shape;
}

// =====================================================================
// Warm Claude CLI process pool (env-gated, default OFF).
//
// Each entry is a `startup({ options })` handle from the SDK. `startup()`
// spawns the CLI subprocess AND awaits the `initialize` handshake before
// resolving — the ~1.5s cold-start cost is paid up front in the background.
// On lease we call `handle.query(prompt)` which injects the prompt into
// the already-warm process and returns the live `Query` iterator. After
// the turn we evict the (one-shot) handle and schedule a background refill
// so the next caller of the same shape skips the cold spawn.
//
// Why `startup()` instead of `query({ prompt: iterable })` deferred-push?
// `query()` is lazy: the CLI subprocess does no real work (including the
// initialize handshake) until the first user message is pushed. So a
// "warm" pool of pre-created `query()` calls saved only ~1ms of pool
// bookkeeping, NOT the spawn+init cost. `startup()` (added in SDK 0.2.x,
// per Anthropic guidance on issue anthropics/claude-agent-sdk-typescript#34)
// is the official pre-warm primitive that drives the handshake to
// completion ahead of the prompt.
//
// Tool-bearing requests are NEVER pooled because the MCP server tool
// closures bind to per-request queues. We also never reuse a worker
// after an abort — aborted workers are always evicted.
// =====================================================================
type SdkQueryFn = typeof import("@anthropic-ai/claude-agent-sdk").query;
type SdkPrompt = string | AsyncIterable<{
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}>;
// `startup` is exported from the SDK (sdk.mjs) but not surfaced in the public
// `.d.ts` yet, so we declare a minimal local type. The runtime contract is:
//   startup({ options }) -> { query(prompt) -> Query, close() -> void }
// `query()` is one-shot — calling twice on the same handle throws.
type SdkWarmHandle = {
  query: (prompt: SdkPrompt) => ReturnType<SdkQueryFn>;
  close: () => void;
};
type SdkStartupFn = (args: { options?: SdkOptions }) => Promise<SdkWarmHandle>;

interface WarmWorker {
  handle: SdkWarmHandle;
  spawnedAt: number;
  key: string;
  evicted: boolean;
  // Stderr from the long-lived warm subprocess flows into whatever buffer the
  // currently-leasing call has registered here. Cleared on release; the
  // stderr callback is a no-op when nothing is registered.
  activeStderrRef: { current: StderrRef | null };
}

const WARM_POOL_SIZE = (() => {
  const raw = process.env.CLAUDE_CLI_WARM_POOL_SIZE;
  // Two one-shot workers provide one active lease plus one ready reserve. Set
  // the env explicitly to 0 to disable the lane, or 1-8 to tune capacity.
  if (raw === undefined) return 2;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(n, 8);
})();
const WARM_MAX_AGE_MS = 5 * 60 * 1000;
const warmPools = new Map<string, WarmWorker[]>();
const warmPoolDefinitions = new Map<string, { sdkOptions: SdkOptions; startupFn: SdkStartupFn }>();

function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function buildPoolKey(
  model: string,
  systemPrompt: string,
  opts: { lane: "orientation"; thinkingKey: string; connectorConfig?: ClaudeCliTierModelConfig },
): string {
  const configKey = opts.connectorConfig ? hashShort(JSON.stringify(opts.connectorConfig)) : "default";
  return `${model}|lane=${opts.lane}|sp=${hashShort(systemPrompt)}|th=${opts.thinkingKey}|cfg=${configKey}`;
}

async function spawnWarmWorker(key: string, sdkOptions: SdkOptions, startupFn: SdkStartupFn): Promise<WarmWorker> {
  // Each worker owns its own stderr fan-out: the SDK's stderr callback is
  // captured by closure at startup, so we can't hand a per-call buffer to a
  // long-lived warm subprocess. Instead we install a worker-bound callback
  // that forwards into whatever buffer the current lease has registered.
  const activeStderrRef: { current: StderrRef | null } = { current: null };
  const workerOptions: SdkOptions = {
    ...sdkOptions,
    stderr: (data: string) => {
      const ref = activeStderrRef.current;
      if (ref) appendStderrTail(ref, data);
    },
  };
  const handle = await startupFn({ options: workerOptions });
  return { handle, spawnedAt: Date.now(), key, evicted: false, activeStderrRef };
}

function acquireWarmWorker(key: string): WarmWorker | null {
  const list = warmPools.get(key);
  if (!list || list.length === 0) return null;
  while (list.length) {
    const w = list.shift()!;
    if (w.evicted || Date.now() - w.spawnedAt > WARM_MAX_AGE_MS) {
      try { w.handle.close(); } catch { /* ignore */ }
      continue;
    }
    return w;
  }
  return null;
}

// Track in-flight refills per key so we don't double-spawn while a previous refill
// is still completing the init handshake (which takes ~1.5s).
const inflightRefills = new Map<string, number>();

function scheduleWarmRefill(key: string, sdkOptions: SdkOptions, startupFn: SdkStartupFn): Promise<void> {
  if (WARM_POOL_SIZE <= 0) return Promise.resolve();
  const definition = warmPoolDefinitions.get(key);
  const refillOptions = definition?.sdkOptions ?? sdkOptions;
  const refillStartupFn = definition?.startupFn ?? startupFn;
  const cur = warmPools.get(key) ?? [];
  const inflight = inflightRefills.get(key) ?? 0;
  if (cur.length + inflight >= WARM_POOL_SIZE) return Promise.resolve();
  inflightRefills.set(key, inflight + 1);
  return new Promise((resolve) => {
    setImmediate(() => {
      void (async () => {
        const t0 = Date.now();
        try {
          const w = await spawnWarmWorker(key, refillOptions, refillStartupFn);
          const list = warmPools.get(key) ?? [];
          if (list.length >= WARM_POOL_SIZE) {
            // Pool already full by the time init finished — close the extra handle.
            try { w.handle.close(); } catch { /* ignore */ }
          } else {
            list.push(w);
            warmPools.set(key, list);
            log.debug(`cli-warm-pool: refilled key=${key} pool_size=${list.length} init_ms=${Date.now() - t0}`);
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          log.warn(`cli-warm-pool: refill failed key=${key} init_ms=${Date.now() - t0} err=${errMsg}`);
          // Upgrade pool refill failures to the same structured crash shape as
          // result-error / thrown so a Railway-only refill crash is no longer
          // hidden behind a single-line warn. We don't have a per-call stderr
          // buffer here (refill happens before any lease), so stderrTail is null.
          emitCliSubprocessCrash({
            phase: "warm_refill",
            // Pool key is `model|sp=…|th=…|cfg=…`; the model is the prefix.
            model: key.split("|")[0] || "unknown",
            rawError: errMsg,
            runId: null,
            convId: null,
            pooledHit: false,
            poolEligible: true,
            workerAgeMs: null,
            elapsedMs: Date.now() - t0,
            eventsReceived: null,
            inputTokens: null,
            outputTokens: null,
            stderrTail: null,
          });
        } finally {
          const remaining = (inflightRefills.get(key) ?? 1) - 1;
          if (remaining <= 0) inflightRefills.delete(key);
          else inflightRefills.set(key, remaining);
          resolve();
        }
      })();
    });
  });
}

// Keep every registered latency-critical lane ready even when calls are infrequent.
// Workers are one-shot and rotate before age can turn the next request into a cold miss.
const warmPoolMaintenance = setInterval(() => {
  if (WARM_POOL_SIZE <= 0) return;
  const now = Date.now();
  const refreshBeforeMs = WARM_MAX_AGE_MS - 30_000;
  for (const [key, definition] of warmPoolDefinitions.entries()) {
    const current = warmPools.get(key) ?? [];
    const ready = current.filter((worker) => {
      const fresh = !worker.evicted && now - worker.spawnedAt <= refreshBeforeMs;
      if (!fresh) {
        try { worker.handle.close(); } catch { /* ignore */ }
      }
      return fresh;
    });
    warmPools.set(key, ready);
    for (let i = ready.length; i < WARM_POOL_SIZE; i++) {
      void scheduleWarmRefill(key, definition.sdkOptions, definition.startupFn);
    }
  }
}, 30_000);
warmPoolMaintenance.unref?.();

export function getWarmPoolStats(): { enabled: boolean; size: number; perKey: Record<string, number> } {
  const perKey: Record<string, number> = {};
  for (const [k, v] of warmPools.entries()) perKey[k] = v.length;
  return { enabled: WARM_POOL_SIZE > 0, size: WARM_POOL_SIZE, perKey };
}

export function isWarmPoolEnabled(): boolean {
  return WARM_POOL_SIZE > 0;
}

function poolThinkingKey(
  connectorConfig: ClaudeCliTierModelConfig | undefined,
  thinking?: import("./thinking-config").ResolvedThinking,
  thinkingBudget?: number,
): string {
  if (connectorConfig?.thinkingMode) {
    return `connector-${connectorConfig.thinkingMode}-${connectorConfig.effort ?? "default"}`;
  }
  if (thinking) return thinkingConfigKey(thinking);
  return `legacy-budget-${thinkingBudget ?? 0}`;
}

// Pre-warm a named latency-critical lane with its exact model and stable system prompt. Without
// this, the very first trivial Haiku turn after boot pays the cold-spawn cost (the warm
// worker is otherwise only spawned via background refill *after* the first turn). We
// build SDK options with the same shape cliSdkStream uses for that path so the pool key
// matches and the next turn is a hit.
export async function prewarmWarmPool(opts: {
  lane: "orientation";
  model: string;
  systemPrompt: string;
  connectorConfig?: ClaudeCliTierModelConfig;
}): Promise<void> {
  if (WARM_POOL_SIZE <= 0) return;
  const token = getSecretSync("CLAUDE_CODE_OAUTH_TOKEN") || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return;
  const sdkMod = await sdkModulePromise;
  const startupFn = (sdkMod as unknown as { startup?: SdkStartupFn }).startup;
  if (!startupFn) {
    log.warn(`cli-warm-pool: prewarm skipped — installed @anthropic-ai/claude-agent-sdk does not export startup()`);
    return;
  }
  const sdkOptions = buildSdkOptions(
    opts.model,
    { thinking: undefined, connectorConfig: opts.connectorConfig },
    undefined,
    token,
  );
  sdkOptions.systemPrompt = opts.systemPrompt;
  const key = buildPoolKey(opts.model, opts.systemPrompt, {
    lane: opts.lane,
    thinkingKey: poolThinkingKey(opts.connectorConfig),
    connectorConfig: opts.connectorConfig,
  });
  warmPoolDefinitions.set(key, { sdkOptions, startupFn });
  // Boot prewarming is a readiness gate, not a fire-and-forget hint. Await the
  // initialize handshakes so routes never accept a fast call before its worker exists.
  await Promise.all(Array.from(
    { length: WARM_POOL_SIZE },
    () => scheduleWarmRefill(key, sdkOptions, startupFn),
  ));
  const readySlots = warmPools.get(key)?.length ?? 0;
  if (readySlots === 0) throw new Error(`Claude CLI warm lane failed to initialize key=${key}`);
  log.info(`cli-warm-pool: ready key=${key} model=${opts.model} slots=${readySlots}`);
}

// Built-in Claude Code tools we never use — we route everything through our own MCP `xyz-tools`.
// Listed explicitly so the CLI does not register/serialize them into the system prompt on every call.
// Verified against @anthropic-ai/claude-agent-sdk 's tool surface.
const HARDENED_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookRead",
  "NotebookEdit",
  "ExitPlanMode",
  "ListMcpResources",
  "ReadMcpResource",
];

function buildSdkOptions(
  model: string,
  options: {
    tools?: ToolDefinition[];
    thinkingBudget?: number;
    thinking?: import("./thinking-config").ResolvedThinking;
    connectorConfig?: ClaudeCliTierModelConfig;
  },
  mcpServer: ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer> | undefined,
  token: string,
): SdkOptions {
  const modelInfo = getModel(model);
  const cliModel = modelInfo?.claudeModelId || undefined;

  const cliPath = resolveCliPath();

  const sdkOptions: SdkOptions = {
    pathToClaudeCodeExecutable: cliPath,
    systemPrompt: undefined,
    // tools: [] disables the built-in Claude Code tool preset. We additionally pass an
    // explicit disallowedTools list as belt-and-suspenders so that even if a future SDK
    // version changes the meaning of `tools: []`, the built-ins stay out of every prompt.
    tools: [],
    disallowedTools: [...HARDENED_DISALLOWED_TOOLS],
    // Stop the CLI from discovering and reading `~/.claude/CLAUDE.md`, project `.claude/CLAUDE.md`,
    // local settings, and on-disk MCP config on every spawn. We drive everything programmatically.
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    persistSession: false,
    env: (() => {
      const e: Record<string, string> = { ...process.env } as Record<string, string>;
      e.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete e.ANTHROPIC_API_KEY;
      return e;
    })(),
  };

  // TODO(prompt-cache): The Claude Agent SDK's `systemPrompt` accepts a plain string and does
  // not currently expose Anthropic `cache_control` breakpoints to mark the stable prefix as
  // cacheable. The CLI bundle decides cache placement internally. To explicitly cache the long
  // stable prefix of our system prompt, the SDK would need to accept a structured systemPrompt
  // (array of blocks with `cache_control: { type: "ephemeral" }`) — until then we rely on the
  // CLI's default caching of system prompt + tools. Re-evaluate when the SDK exposes a hook.

  if (cliModel) {
    sdkOptions.model = cliModel;
  }

  if (mcpServer) {
    sdkOptions.mcpServers = { "xyz-tools": mcpServer };
  }

  const connectorConfig = options.connectorConfig;
  if (connectorConfig?.thinkingMode === "disabled") {
    sdkOptions.thinking = { type: "disabled" };
  } else if (connectorConfig?.thinkingMode === "adaptive" || connectorConfig?.effort) {
    sdkOptions.thinking = { type: "adaptive" };
    if (connectorConfig.effort) sdkOptions.effort = connectorConfig.effort;
  } else if (options.thinking) {
    const t = options.thinking.thinking;
    if (t.type === "disabled") {
      sdkOptions.thinking = { type: "disabled" };
    } else if (t.type === "enabled") {
      sdkOptions.thinking = { type: "enabled", budgetTokens: t.budgetTokens };
    } else {
      sdkOptions.thinking = { type: "adaptive" };
      if (options.thinking.effort) sdkOptions.effort = options.thinking.effort;
    }
  } else if (options.thinkingBudget) {
    sdkOptions.thinking = { type: "enabled", budgetTokens: options.thinkingBudget };
  } else {
    sdkOptions.thinking = { type: "disabled" };
  }

  if (connectorConfig?.maxTurns !== undefined) sdkOptions.maxTurns = connectorConfig.maxTurns;

  return sdkOptions;
}

function buildPrompt(messages: Array<{ role: string; content: unknown; toolCallId?: string }>): { systemPrompt: string | undefined; prompt: string } {
  const systemMessages: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (msg.role === "system") {
      systemMessages.push(content);
    } else if (msg.role === "user") {
      conversationParts.push(`[User]\n${content}`);
    } else if (msg.role === "assistant") {
      conversationParts.push(`[Assistant]\n${content}`);
    } else if (msg.role === "tool" || msg.role === "tool_result") {
      const toolId = msg.toolCallId || "";
      conversationParts.push(`[Tool Result${toolId ? ` (${toolId})` : ""}]\n${content}`);
    }
  }

  return {
    systemPrompt: systemMessages.length > 0 ? systemMessages.join("\n\n") : undefined,
    prompt: conversationParts.join("\n\n"),
  };
}

function createMcpTools(
  toolDefs: ToolDefinition[],
  toolExecutor: ToolExecutor | undefined,
  toolResultQueue: StreamEvent[],
  pendingToolCallIdQueue: string[],
  sdkToolFn: typeof import("@anthropic-ai/claude-agent-sdk").tool,
  notifyToolEvent?: () => void,
  requestContinuationHandoff?: (toolCallId: string, continuation: import("./agent-executor").ToolContinuation) => Promise<void>,
) {
  let toolCallCounter = 0;
  let activeToolExecutions = 0;
  let toolActivityGeneration = 0;
  let pendingContinuation: {
    toolCallId: string;
    continuation: import("./agent-executor").ToolContinuation;
    resolve: () => void;
  } | null = null;
  let continuationHandoffScheduled = false;
  let correlationWaitStartedAt: number | null = null;
  const scheduleContinuationHandoff = () => {
    if (continuationHandoffScheduled || !pendingContinuation) return;
    continuationHandoffScheduled = true;
    const observedGeneration = toolActivityGeneration;
    setTimeout(async () => {
      continuationHandoffScheduled = false;
      if (!pendingContinuation) return;
      if (activeToolExecutions > 0 || observedGeneration !== toolActivityGeneration) {
        scheduleContinuationHandoff();
        return;
      }
      if (correlationWaitStartedAt === null) correlationWaitStartedAt = Date.now();
      if (pendingToolCallIdQueue.length > 0 && Date.now() - correlationWaitStartedAt < 500) {
        scheduleContinuationHandoff();
        return;
      }
      if (pendingToolCallIdQueue.length > 0) {
        log.warn(`cliSdkStream: bounded stale correlation wait expired pendingIds=${pendingToolCallIdQueue.length}`);
      }
      correlationWaitStartedAt = null;
      const handoff = pendingContinuation;
      pendingContinuation = null;
      try {
        await requestContinuationHandoff?.(handoff.toolCallId, handoff.continuation);
      } finally {
        handoff.resolve();
      }
    }, 25);
  };

  return toolDefs.map((def) => {
    const zodShape = toolDefToZodShape(def);
    return sdkToolFn(
      def.name,
      def.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        const invocationOrder = toolCallCounter++;
        const callId = pendingToolCallIdQueue.shift() || `sdk-tool-${Date.now()}-${invocationOrder}`;

        const HEARTBEAT_INTERVAL_MS = 15_000;
        const emitKeepalive = (reason: string) => {
          toolResultQueue.push({ type: "keepalive", reason } as StreamEvent);
          notifyToolEvent?.();
        };

        emitKeepalive(`tool_exec_start:${def.name}`);

        if (!toolExecutor) {
          const errText = `Error: No tool executor available for "${def.name}"`;
          toolResultQueue.push({
            type: "tool_result_resolved",
            toolCallId: callId,
            toolName: def.name,
            arguments: args,
            order: invocationOrder,
            result: errText,
            error: true,
          });
          notifyToolEvent?.();
          return { content: [{ type: "text" as const, text: errText }], isError: true };
        }

        activeToolExecutions++;
        toolActivityGeneration++;
        let executionReleased = false;
        const releaseExecution = () => {
          if (executionReleased) return;
          executionReleased = true;
          activeToolExecutions = Math.max(0, activeToolExecutions - 1);
          toolActivityGeneration++;
          scheduleContinuationHandoff();
        };
        const heartbeat = setInterval(() => emitKeepalive(`tool_exec_active:${def.name}`), HEARTBEAT_INTERVAL_MS);
        try {
          const result = await toolExecutor(def.name, args);
          toolResultQueue.push({
            type: "tool_result_resolved",
            toolCallId: callId,
            toolName: def.name,
            arguments: args,
            order: invocationOrder,
            result: result.result,
            error: result.error,
            continuation: result.continuation,
          });
          if (result.continuation) {
            await new Promise<void>((resolve) => {
              pendingContinuation = { toolCallId: callId, continuation: result.continuation!, resolve };
              releaseExecution();
              notifyToolEvent?.();
              scheduleContinuationHandoff();
            });
          } else {
            notifyToolEvent?.();
          }
          return {
            content: [{ type: "text" as const, text: result.result }],
            isError: result.error || false,
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errText = `Tool execution error: ${errMsg}`;
          toolResultQueue.push({
            type: "tool_result_resolved",
            toolCallId: callId,
            toolName: def.name,
            arguments: args,
            order: invocationOrder,
            result: errText,
            error: true,
          });
          notifyToolEvent?.();
          return { content: [{ type: "text" as const, text: errText }], isError: true };
        } finally {
          clearInterval(heartbeat);
          releaseExecution();
        }
      },
    );
  });
}

export async function* cliSdkStream(
  model: string,
  options: ChatCompletionStreamOptions & { toolExecutor?: ToolExecutor; voiceSessionId?: string },
): AsyncGenerator<StreamEvent> {
  const ttftStart = Date.now();
  const { query, tool: sdkToolFn, createSdkMcpServer } = await sdkModulePromise;
  const sdkImportMs = Date.now() - ttftStart;

  const token = getSecretSync("CLAUDE_CODE_OAUTH_TOKEN");
  if (!token) {
    yield { type: "error", error: "Claude CLI subscription not configured. Please add CLAUDE_CODE_OAUTH_TOKEN in Settings → Connections." };
    return;
  }

  const toolDefs = options.tools || [];
  const toolExecutor = options.toolExecutor;

  if (toolDefs.length > 0 && !toolExecutor) {
    log.debug("cliSdkStream: tools provided but no toolExecutor — tools will NOT be executable by SDK");
  }

  const toolResultQueue: StreamEvent[] = [];
  const pendingToolCallIdQueue: string[] = [];

  let toolEventResolve: (() => void) | null = null;
  let toolEventPromise: Promise<"tool_event"> | null = null;
  const createToolEventPromise = () => {
    toolEventPromise = new Promise<"tool_event">((resolve) => {
      toolEventResolve = () => resolve("tool_event");
    });
  };
  createToolEventPromise();
  const notifyToolEvent = () => {
    if (toolEventResolve) {
      toolEventResolve();
      toolEventResolve = null;
    }
  };
  let continuationHandoff: {
    toolCallId: string;
    continuation: import("./agent-executor").ToolContinuation;
    resolve: () => void;
  } | null = null;
  const requestContinuationHandoff = (toolCallId: string, continuation: import("./agent-executor").ToolContinuation) =>
    new Promise<void>((resolve) => {
      continuationHandoff = { toolCallId, continuation, resolve };
      notifyToolEvent();
    });

  const sdkTools = createMcpTools(
    toolDefs,
    toolExecutor,
    toolResultQueue,
    pendingToolCallIdQueue,
    sdkToolFn,
    notifyToolEvent,
    requestContinuationHandoff,
  );

  const mcpServer = sdkTools.length > 0
    ? createSdkMcpServer({ name: "xyz-tools", tools: sdkTools })
    : undefined;

  const { systemPrompt, prompt } = buildPrompt(options.messages);

  const connectorConfig = resolvedClaudeCliConfig(options);
  const sdkOptions = buildSdkOptions(model, { ...options, connectorConfig }, mcpServer, token);
  sdkOptions.systemPrompt = systemPrompt;

  const start = ttftStart;
  let queryInvokedAt: number = start;
  let handoffDoneAt: number | null = null;
  let firstEventAt: number | null = null;
  let firstEventType: string | null = null;
  let firstTextAt: number | null = null;
  let eventCount = 0;
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let usageSource = "assistant.usage";
  let sawStreamDeltas = false;
  let connectedEmitted = false;
  let ttftLogged = false;

  // Emit a single greppable structured TTFT line per call. Called at first text delta
  // (or at end-of-call if no text was emitted), and idempotent. The breakdown carves the
  // hand-off path into named sub-phases that line up with the UI's Request Sent /
  // Connected / First Token markers, so on-screen numbers and log line agree.
  const emitTtftBreakdownLog = () => {
    if (ttftLogged) return;
    ttftLogged = true;
    const preSdk = queryInvokedAt - start;
    const poolAcquire = handoffDoneAt !== null ? handoffDoneAt - queryInvokedAt : null;
    const sdkToFirstEvent = firstEventAt !== null && handoffDoneAt !== null
      ? firstEventAt - handoffDoneAt
      : null;
    const firstEventToFirstText = firstEventAt !== null && firstTextAt !== null
      ? firstTextAt - firstEventAt
      : null;
    const totalTtft = firstTextAt !== null ? firstTextAt - start : null;

    const line =
      `ttft_breakdown model=${model} pool_eligible=${poolEligible} pool_hit=${pooledHit} ` +
      `sdk_import_ms=${sdkImportMs} pre_sdk=${preSdk}ms ` +
      `pool_acquire=${poolAcquire ?? "n/a"}ms sdk_to_first_event=${sdkToFirstEvent ?? "n/a"}ms ` +
      `first_event_to_first_text=${firstEventToFirstText ?? "n/a"}ms ` +
      `first_event_type=${firstEventType ?? "n/a"} total_ttft=${totalTtft ?? "n/a"}ms`;

    log.debug(line);

    // Guard the win: warn loudly when the dedicated Haiku fast lane regresses past
    // 1.5s. The nested Orientation LLM phases expose the same breakdown in-product.
    const isHaiku = /haiku/i.test(model);
    if (poolEligible && isHaiku && totalTtft !== null && totalTtft > 1500) {
      log.warn(
        `ttft_regression: tool-free Haiku TTFT exceeded 1500ms — ` + line,
      );
    }
  };

  const INTERRUPT_HARD_TIMEOUT_MS = 3000;
  const PROCESS_KILL_TIMEOUT_MS = 10_000; // hard-kill subprocess if iterator.return() stalls
  const FIRST_EVENT_STALL_MS = 30_000; // warn if no SDK events within this window
  let abortRejectFn: (() => void) | null = null;
  let forceAbortTimer: ReturnType<typeof setTimeout> | null = null;
  let processKillTimer: ReturnType<typeof setTimeout> | null = null;
  let firstEventStallTimer: ReturnType<typeof setTimeout> | null = null;
  let iterator: AsyncIterator<any> | null = null;
  let abortFiredAt: number | null = null;

  // AbortController for cold-spawn SDK sessions — lets us force-kill the
  // underlying subprocess when cooperative interrupt + iterator.return() stall.
  const sdkAbortController = new AbortController();

  // Decide whether this call can ride a warm pool worker. We only pool tool-free requests
  // because MCP tool closures capture per-request queues; a pooled worker carrying the wrong
  // closure would cross-talk between calls. Pool key includes systemPrompt hash so different
  // activity profiles don't collide.
  const poolEligible = WARM_POOL_SIZE > 0
    && options.warmPoolLane === "orientation"
    && toolDefs.length === 0
    && !toolExecutor;
  const thinkingKey = poolThinkingKey(connectorConfig, options.thinking, options.thinkingBudget);
  const pKey = poolEligible
    ? buildPoolKey(model, systemPrompt ?? "", {
        lane: options.warmPoolLane!,
        thinkingKey,
        connectorConfig,
      })
    : "";
  let pooledWorker: WarmWorker | null = null;
  let pooledHit = false;
  let voiceWarmHit = false;

  // Per-call stderr buffer. For cold spawns we attach the SDK's stderr
  // callback directly. For pool hits, we register this buffer on the worker's
  // `activeStderrRef` so the worker-bound callback (installed at startup) can
  // route stderr here for the duration of this lease.
  const stderrBuf: StderrRef = { tail: "" };

  try {
    log.debug(`cliSdkStream: starting query model=${model} tools=${toolDefs.length} hasToolExecutor=${!!toolExecutor} pool_eligible=${poolEligible}`);

    queryInvokedAt = Date.now();
    let q!: ReturnType<typeof query>;

    // Voice pre-warm: if a warm handle exists for this voice session, claim it
    // and skip both pool and cold spawn.
    if (options.voiceSessionId && toolExecutor) {
      const warmHandle = claimVoiceWarmHandle(options.voiceSessionId, toolExecutor);
      if (warmHandle) {
        voiceWarmHit = true;
        q = warmHandle.query(prompt);
        log.debug(`voice-warm: hit sessionId=${options.voiceSessionId}`);
      }
    }

    if (!voiceWarmHit) {
      if (poolEligible) {
        pooledWorker = acquireWarmWorker(pKey);
        if (pooledWorker) {
          pooledHit = true;
          pooledWorker.activeStderrRef.current = stderrBuf;
          q = pooledWorker.handle.query(prompt);
          log.debug(`cli-warm-pool: hit key=${pKey} worker_age_ms=${Date.now() - pooledWorker.spawnedAt}`);
        } else {
          sdkOptions.stderr = (data: string) => appendStderrTail(stderrBuf, data);
          sdkOptions.abortController = sdkAbortController;
          q = query({ prompt, options: sdkOptions });
          log.debug(`cli-warm-pool: miss key=${pKey} cold_spawn`);
        }
      } else {
        sdkOptions.stderr = (data: string) => appendStderrTail(stderrBuf, data);
        sdkOptions.abortController = sdkAbortController;
        q = query({ prompt, options: sdkOptions });
      }
    }
    handoffDoneAt = Date.now();
    if (poolEligible) {
      const startupFn = (await sdkModulePromise as unknown as { startup?: SdkStartupFn }).startup;
      if (startupFn) void scheduleWarmRefill(pKey, sdkOptions, startupFn);
    }

    // Tell the executor that we've fully handed off to the SDK / pool. This is what
    // "Request Sent" should reflect in the UI — the time from chatCompletionStream entry
    // through buildSdkOptions, MCP construction, and pool acquire/cold spawn. The
    // separate `connected` event below fires when the SDK actually emits its first event.
    yield {
      type: "request_sent" as const,
      metadata: {
        poolKey: pKey || undefined,
        poolEligible,
        poolHit: pooledHit,
        voiceWarmHit,
        preSdkMs: queryInvokedAt - start,
        sdkImportMs,
        poolAcquireMs: handoffDoneAt - queryInvokedAt,
      },
    } as StreamEvent;

    // First-event stall detection: warn loudly if the SDK never emits a first
    // event within FIRST_EVENT_STALL_MS. This catches silent hangs where the
    // subprocess starts but the stream never produces data.
    firstEventStallTimer = setTimeout(() => {
      firstEventStallTimer = null;
      if (firstEventAt === null && !options.signal?.aborted) {
        log.warn(
          `cliSdkStream: [stall] no SDK events received after ${FIRST_EVENT_STALL_MS}ms — ` +
          `stream may be hung model=${model} pool_hit=${pooledHit} ` +
          `events_so_far=${eventCount} stderr_tail="${stderrBuf.tail.slice(-200)}"`,
        );
      }
    }, FIRST_EVENT_STALL_MS);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        abortFiredAt = Date.now();
        activeZombieCount++;
        if (activeZombieCount > peakZombieCount) peakZombieCount = activeZombieCount;
        log.debug(`cliSdkStream: [zombie-track] abort signal fired at=${abortFiredAt} model=${model} active_zombies=${activeZombieCount} peak=${peakZombieCount}`);
        log.debug(`cliSdkStream: abort signal received, interrupting query model=${model}`);
        // Register the interrupt promise with the executor so its post-abort drain
        // window actually waits for the CLI to acknowledge before the admission slot
        // is released. We still convert errors to warn-logs (interrupt failures are
        // not fatal to the run that already terminated), but we no longer detach
        // them from the run's bookkeeping.
        const interruptPromise = q.interrupt().then(
          () => {
            const interruptDoneAt = Date.now();
            log.debug(`cliSdkStream: [zombie-track] interrupt() resolved at=${interruptDoneAt} delta=${interruptDoneAt - abortFiredAt!}ms model=${model}`);
          },
          (err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            const interruptFailedAt = Date.now();
            log.warn(`cliSdkStream: [zombie-track] interrupt() failed at=${interruptFailedAt} delta=${interruptFailedAt - abortFiredAt!}ms model=${model}: ${errMsg}`);
          },
        );
        options.registerBackgroundWork?.(interruptPromise);
        forceAbortTimer = setTimeout(() => {
          forceAbortTimer = null;
          const forceAbortAt = Date.now();
          log.warn(`cliSdkStream: [zombie-track] force-abort timer fired at=${forceAbortAt} delta=${forceAbortAt - abortFiredAt!}ms model=${model}`);
          if (abortRejectFn) {
            log.warn(`cliSdkStream: interrupt did not stop iterator within ${INTERRUPT_HARD_TIMEOUT_MS}ms — force-breaking model=${model}`);
            abortRejectFn();
            abortRejectFn = null;
          }
        }, INTERRUPT_HARD_TIMEOUT_MS);
        // Hard kill: if the subprocess still hasn't terminated after
        // PROCESS_KILL_TIMEOUT_MS, forcefully tear it down. For pooled workers
        // we call handle.close(); for cold spawns we abort the SDK's
        // AbortController which signals the subprocess to exit.
        processKillTimer = setTimeout(() => {
          processKillTimer = null;
          const killAt = Date.now();
          log.warn(
            `cliSdkStream: [zombie-kill] subprocess still alive after ${PROCESS_KILL_TIMEOUT_MS}ms — ` +
            `force-killing model=${model} pooled=${!!pooledWorker} delta=${killAt - abortFiredAt!}ms`,
          );
          if (pooledWorker) {
            try { pooledWorker.handle.close(); } catch (e) {
              log.warn(`cliSdkStream: [zombie-kill] pooled handle.close() failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            pooledWorker.evicted = true;
          }
          // For cold spawns (and as belt-and-suspenders for pooled), abort the
          // SDK's AbortController which triggers SIGTERM on the child process.
          if (!sdkAbortController.signal.aborted) {
            sdkAbortController.abort();
            log.debug(`cliSdkStream: [zombie-kill] sdkAbortController.abort() called model=${model}`);
          }
          // Decrement zombie count — the process is now dead or dying
          if (abortFiredAt) activeZombieCount = Math.max(0, activeZombieCount - 1);
          log.debug(`cliSdkStream: [zombie-kill] cleanup complete model=${model} active_zombies=${activeZombieCount}`);
        }, PROCESS_KILL_TIMEOUT_MS);
      }, { once: true });
    }

    iterator = q[Symbol.asyncIterator]();
    let iterDone = false;
    let pendingIterPromise: Promise<IteratorResult<any>> | null = null;
    while (!iterDone) {
      if (!pendingIterPromise) {
        pendingIterPromise = iterator.next();
      }
      const abortPromise = new Promise<never>((_, reject) => {
        abortRejectFn = () => reject(new Error("force_abort_timeout"));
      });

      let raceResult: "tool_event" | IteratorResult<any>;
      try {
        raceResult = await Promise.race([pendingIterPromise, abortPromise, toolEventPromise!]);
      } catch (raceErr: unknown) {
        if (raceErr instanceof Error && raceErr.message === "force_abort_timeout") {
          throw raceErr;
        }
        throw raceErr;
      } finally {
        abortRejectFn = null;
      }

      if (raceResult === "tool_event") {
        createToolEventPromise();
        while (toolResultQueue.length > 0) {
          yield toolResultQueue.shift()!;
        }
        if (continuationHandoff) {
          const handoff = continuationHandoff;
          continuationHandoff = null;
          log.debug(`cliSdkStream: controlled continuation handoff requested type=${handoff.continuation} toolCallId=${handoff.toolCallId} model=${model}`);
          try {
            await Promise.race([
              q.interrupt(),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("continuation_interrupt_timeout")), INTERRUPT_HARD_TIMEOUT_MS)),
            ]);
          } catch (interruptErr: unknown) {
            log.warn(`cliSdkStream: controlled continuation interrupt degraded model=${model}: ${interruptErr instanceof Error ? interruptErr.message : String(interruptErr)}`);
            if (!sdkAbortController.signal.aborted) sdkAbortController.abort();
          }
          // interrupt() confirms the old query stopped processing. Release the MCP
          // callback only after that boundary, then close the iterator so return()
          // cannot deadlock waiting for the callback it is trying to unwind.
          handoff.resolve();
          try {
            await Promise.race([
              iterator?.return?.() ?? Promise.resolve({ done: true, value: undefined }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("continuation_return_timeout")), INTERRUPT_HARD_TIMEOUT_MS)),
            ]);
          } catch (returnErr: unknown) {
            log.warn(`cliSdkStream: controlled continuation iterator close degraded model=${model}: ${returnErr instanceof Error ? returnErr.message : String(returnErr)}`);
            if (!sdkAbortController.signal.aborted) sdkAbortController.abort();
          }
          pendingIterPromise = null;
          iterDone = true;
          break;
        }
        continue;
      }

      const msg = raceResult as IteratorResult<any>;
      pendingIterPromise = null;

      if (msg.done) {
        iterDone = true;
        if (abortFiredAt) {
          activeZombieCount = Math.max(0, activeZombieCount - 1);
          log.debug(`cliSdkStream: [zombie-track] iterator completed naturally after abort, total_zombie_duration=${Date.now() - abortFiredAt}ms model=${model} active_zombies=${activeZombieCount}`);
        }
        break;
      }
      const iterValue = msg.value;
      if (options.signal?.aborted) {
        log.debug(`cliSdkStream: abort detected mid-stream — terminating iterator model=${model}`);
        const iterReturnStart = Date.now();
        try { await iterator?.return?.(); } catch (retErr: unknown) {
          log.warn(`cliSdkStream: iterator.return() failed on mid-stream abort: ${retErr instanceof Error ? retErr.message : String(retErr)}`);
        }
        const iterReturnEnd = Date.now();
        if (abortFiredAt) activeZombieCount = Math.max(0, activeZombieCount - 1);
        log.debug(`cliSdkStream: [zombie-track] iterator.return() completed in ${iterReturnEnd - iterReturnStart}ms model=${model}${abortFiredAt ? ` total_zombie_duration=${iterReturnEnd - abortFiredAt}ms` : ""} active_zombies=${activeZombieCount}`);
        if (forceAbortTimer) { clearTimeout(forceAbortTimer); forceAbortTimer = null; }
        if (processKillTimer) { clearTimeout(processKillTimer); processKillTimer = null; }
        break;
      }
      eventCount++;
      if (firstEventAt === null) {
        firstEventAt = Date.now();
        firstEventType = typeof iterValue?.type === "string" ? iterValue.type : "unknown";
        if (firstEventStallTimer) { clearTimeout(firstEventStallTimer); firstEventStallTimer = null; }
      }
      if (!connectedEmitted) {
        connectedEmitted = true;
        yield {
          type: "connected",
          metadata: {
            poolKey: pKey || undefined,
            poolEligible,
            poolHit: pooledHit,
            firstEventType,
            sdkToFirstEventMs: firstEventAt - (handoffDoneAt ?? queryInvokedAt),
          },
        } as StreamEvent;
      }

      while (toolResultQueue.length > 0) {
        yield toolResultQueue.shift()!;
      }

      switch (iterValue.type) {
        case "stream_event": {
          const sdkEvent = iterValue.event;
          if (sdkEvent.type === "content_block_delta") {
            const delta = sdkEvent.delta as { type?: string; thinking?: string; text?: string };
            if (delta?.type === "thinking_delta" && delta?.thinking) {
              sawStreamDeltas = true;
              yield { type: "thinking_delta", content: delta.thinking };
            } else if (delta?.type === "text_delta" && delta?.text) {
              sawStreamDeltas = true;
              fullText += delta.text;
              if (firstTextAt === null) {
                firstTextAt = Date.now();
                emitTtftBreakdownLog();
              }
              yield { type: "text_delta", content: delta.text };
            }
          }
          break;
        }

        case "assistant": {
          const betaMsg = iterValue.message;
          const assistantUsage = normalizeClaudeCliUsage(betaMsg.usage, "assistant.usage");
          if (assistantUsage) {
            inputTokens += assistantUsage.inputTokens;
            outputTokens += assistantUsage.outputTokens;
            cacheReadTokens += assistantUsage.cacheReadTokens;
            cacheWriteTokens += assistantUsage.cacheWriteTokens;
            usageSource = assistantUsage.source;
          }

          for (const block of betaMsg.content) {
            if (block.type === "tool_use") {
              pendingToolCallIdQueue.push(block.id);
              yield {
                type: "tool_call_resolved",
                toolCallId: block.id,
                toolName: block.name,
                arguments: (block.input || {}) as Record<string, unknown>,
              };
            } else if (!sawStreamDeltas) {
              if (block.type === "thinking" && "thinking" in block && typeof (block as Record<string, unknown>).thinking === "string") {
                yield { type: "thinking_delta", content: (block as Record<string, unknown>).thinking as string };
              } else if (block.type === "text" && "text" in block && block.text) {
                fullText += block.text;
                if (firstTextAt === null) {
                  firstTextAt = Date.now();
                  emitTtftBreakdownLog();
                }
                yield { type: "text_delta", content: block.text };
              }
            }
          }
          break;
        }

        case "result": {
          const resultMsg = iterValue as {
            type: "result";
            subtype: string;
            result?: string;
            usage?: unknown;
            modelUsage?: Record<string, unknown>;
            errors?: string[];
          };
          if (resultMsg.result && typeof resultMsg.result === "string" && !fullText) {
            fullText = resultMsg.result;
            if (firstTextAt === null) {
              firstTextAt = Date.now();
              emitTtftBreakdownLog();
            }
            yield { type: "text_delta", content: fullText };
          }

          const resultUsage = normalizeClaudeCliUsage(resultMsg.usage, "result.usage")
            ?? normalizeClaudeCliModelUsage(resultMsg.modelUsage);
          if (resultUsage) {
            const applied = applyClaudeCliUsage(resultUsage);
            inputTokens = applied.inputTokens;
            outputTokens = applied.outputTokens;
            cacheReadTokens = applied.cacheReadTokens;
            cacheWriteTokens = applied.cacheWriteTokens;
            usageSource = resultUsage.source;
          }

          if (resultMsg.subtype && resultMsg.subtype.startsWith("error")) {
            const rawErr = Array.isArray(resultMsg.errors) && resultMsg.errors.length > 0
              ? resultMsg.errors.join("; ")
              : `SDK query failed: ${resultMsg.subtype}`;
            emitCliSubprocessCrash({
              phase: "result_error",
              model,
              rawError: `subtype=${resultMsg.subtype} ${rawErr}`,
              runId: options.runId ?? null,
              convId: options.convId ?? null,
              pooledHit,
              poolEligible,
              workerAgeMs: pooledWorker ? Date.now() - pooledWorker.spawnedAt : null,
              elapsedMs: Date.now() - start,
              eventsReceived: eventCount,
              inputTokens,
              outputTokens,
              stderrTail: stderrBuf.tail || null,
            });
            yield { type: "error", error: friendlyCliError(rawErr, model) };
          }
          break;
        }

        default:
          break;
      }
    }

    while (toolResultQueue.length > 0) {
      yield toolResultQueue.shift()!;
    }

    // Catch-all: emit ttft breakdown for tool-only / thinking-only / no-text turns so
    // every call lands exactly one structured TTFT line in the logs.
    emitTtftBreakdownLog();

    const doneAt = Date.now();
    const elapsed = doneAt - start;
    const spawnMs = queryInvokedAt - start;
    const firstEventMs = firstEventAt !== null ? firstEventAt - queryInvokedAt : null;
    const streamMs = firstEventAt !== null ? doneAt - firstEventAt : null;
    log.debug(
      `cliSdkStream: done model=${model} events=${eventCount} elapsed=${elapsed}ms ` +
      `spawn=${spawnMs}ms first_event=${firstEventMs ?? "n/a"}ms stream=${streamMs ?? "n/a"}ms ` +
      `tokens=${inputTokens}+${outputTokens} cache=${cacheReadTokens}+${cacheWriteTokens}`
    );

    yield {
      type: "usage",
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      },
      model,
      stopReason: "end_turn",
      metadata: {
        cli_spawn_ms: spawnMs,
        cli_first_event_ms: firstEventMs,
        cli_stream_ms: streamMs,
        cli_elapsed_ms: elapsed,
        cli_event_count: eventCount,
        cliTiming: {
          providerStartedAt: start,
          requestSentAt: handoffDoneAt,
          firstEventAt,
          firstTextAt,
          providerEndedAt: doneAt,
          sdkImportMs,
          preSdkMs: queryInvokedAt - start,
          poolAcquireMs: handoffDoneAt !== null ? handoffDoneAt - queryInvokedAt : null,
          sdkToFirstEventMs: firstEventAt !== null && handoffDoneAt !== null ? firstEventAt - handoffDoneAt : null,
          firstEventToFirstTextMs: firstEventAt !== null && firstTextAt !== null ? firstTextAt - firstEventAt : null,
          totalTtftMs: firstTextAt !== null ? firstTextAt - start : null,
          totalMs: elapsed,
          afterFirstTextMs: firstTextAt !== null ? doneAt - firstTextAt : null,
          firstEventType,
          poolKey: pKey || undefined,
          poolEligible,
          poolHit: pooledHit,
          voiceWarmHit,
        },
        tokenAccounting: {
          providerReportedUsage: usageSource,
          cacheReadTokens,
          cacheWriteTokens,
          usageSemantics: usageSource === "assistant.usage" ? "cumulative_provider_session" : "unknown",
        },
        usageSemantics: usageSource === "assistant.usage" ? "cumulative_provider_session" : "unknown",
        claudeConnectorConfig: connectorConfig ?? { model },
      },
    };
  } catch (err: unknown) {
    emitTtftBreakdownLog();
    if (forceAbortTimer) { clearTimeout(forceAbortTimer); forceAbortTimer = null; }
    if (firstEventStallTimer) { clearTimeout(firstEventStallTimer); firstEventStallTimer = null; }
    // Note: processKillTimer is intentionally NOT cleared here — it serves as the
    // backstop that force-kills the subprocess if the background iterator.return()
    // below hangs. It self-clears when it fires or is cleared by the finally block
    // if the background work completes in time.
    const isForceAbort = err instanceof Error && err.message === "force_abort_timeout";
    if (isForceAbort) {
      log.warn(`cliSdkStream: force-aborted after interrupt timeout — terminating iterator in background model=${model}`);
      if (iterator) {
        const iterRef = iterator;
        iterator = null;
        // Hand the iterator-return chain to the executor's background-work registry
        // instead of detaching it. The executor's drain window blocks the slot
        // release on this promise (with a bounded grace), so we don't return to
        // "free" while a CLI subprocess + reader is still alive holding pool /
        // file-descriptor resources.
        const bgIterReturn = (async () => {
          const iterReturnStart = Date.now();
          try {
            await iterRef.return?.();
          } catch (retErr: unknown) {
            log.warn(`cliSdkStream: iterator.return() failed on force-abort (bg): ${retErr instanceof Error ? retErr.message : String(retErr)}`);
          }
          const iterReturnEnd = Date.now();
          // Iterator drained cleanly — cancel the hard kill timer since the
          // subprocess is no longer hanging.
          if (processKillTimer) { clearTimeout(processKillTimer); processKillTimer = null; }
          if (abortFiredAt) activeZombieCount = Math.max(0, activeZombieCount - 1);
          log.debug(`cliSdkStream: [zombie-track] force-abort iterator.return() completed (bg) in ${iterReturnEnd - iterReturnStart}ms model=${model}${abortFiredAt ? ` total_zombie_duration=${iterReturnEnd - abortFiredAt}ms` : ""} active_zombies=${activeZombieCount}`);
        })();
        if (options.registerBackgroundWork) {
          options.registerBackgroundWork(bgIterReturn);
        } else {
          // No registry attached — log if it eventually fails so we don't silently
          // swallow it. We are still spawning it (we have to; the foreground call
          // is throwing right now), but at least the failure path is loud.
          bgIterReturn.then(
            () => undefined,
            (e: unknown) => log.warn(`cliSdkStream: bg iter return rejected with no registry: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
      } else {
        if (abortFiredAt) activeZombieCount = Math.max(0, activeZombieCount - 1);
      }
      log.debug(`cliSdkStream: abort lifecycle complete — requested→interrupt→timeout→iterator_terminated (registered) model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
    } else if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      log.debug(`cliSdkStream: aborted — terminating iterator model=${model}`);
      const iterReturnStart = Date.now();
      try { await iterator?.return?.(); } catch (retErr: unknown) {
        log.warn(`cliSdkStream: iterator.return() failed on abort: ${retErr instanceof Error ? retErr.message : String(retErr)}`);
      }
      const iterReturnEnd = Date.now();
      if (processKillTimer) { clearTimeout(processKillTimer); processKillTimer = null; }
      if (abortFiredAt) activeZombieCount = Math.max(0, activeZombieCount - 1);
      log.debug(`cliSdkStream: [zombie-track] abort iterator.return() completed in ${iterReturnEnd - iterReturnStart}ms model=${model}${abortFiredAt ? ` total_zombie_duration=${iterReturnEnd - abortFiredAt}ms` : ""} active_zombies=${activeZombieCount}`);
      log.debug(`cliSdkStream: abort lifecycle complete — requested→interrupt→iterator_terminated model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Derive lifecycle phase: pre_first_event (never started streaming),
      // during_tool_loop (we issued a tool_use and are awaiting its result),
      // or post_first_event (mid-text-stream).
      const phase: CliCrashPhase = firstEventAt === null
        ? "pre_first_event"
        : pendingToolCallIdQueue.length > 0
        ? "during_tool_loop"
        : "post_first_event";
      emitCliSubprocessCrash({
        phase,
        model,
        rawError: errMsg,
        runId: options.runId ?? null,
        convId: options.convId ?? null,
        pooledHit,
        poolEligible,
        workerAgeMs: pooledWorker ? Date.now() - pooledWorker.spawnedAt : null,
        elapsedMs: Date.now() - start,
        eventsReceived: eventCount,
        inputTokens,
        outputTokens,
        stderrTail: stderrBuf.tail || null,
      });

      if (/usageMetadata is not defined/i.test(errMsg) && fullText) {
        log.warn(
          `cliSdkStream: degrading post-output SDK usage finalization failure model=${model} ` +
          `events=${eventCount} input=${inputTokens} output=${outputTokens}`,
        );
        yield {
          type: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
          },
          model,
          stopReason: "end_turn",
          metadata: {
            degraded: true,
            degradationReason: "claude_cli_usage_finalization_failed",
            tokenAccounting: {
              providerReportedUsage: usageSource,
              cacheReadTokens,
              cacheWriteTokens,
              usageSemantics: usageSource === "assistant.usage" ? "cumulative_provider_session" : "unknown",
            },
            usageSemantics: usageSource === "assistant.usage" ? "cumulative_provider_session" : "unknown",
          },
        };
      } else if (errMsg.includes("expired") || errMsg.includes("invalid") || errMsg.includes("unauthorized") || errMsg.includes("401")) {
        yield { type: "error", error: "Claude CLI token expired or invalid. Please re-run `claude setup-token` and update the secret." };
      } else {
        yield { type: "error", error: friendlyCliError(errMsg, model) };
      }
    }
    // Aborted/errored pooled workers must be evicted, never returned to the pool.
    if (pooledWorker) pooledWorker.evicted = true;
  } finally {
    // Clean up any outstanding timers
    if (firstEventStallTimer) { clearTimeout(firstEventStallTimer); firstEventStallTimer = null; }
    // Release the worker's stderr binding so a subsequent (non-evicted) lease
    // doesn't accidentally append into this call's buffer. Evicted workers
    // get closed by acquireWarmWorker on the next attempt; clearing the ref
    // is still correct in case the worker is somehow reused.
    if (pooledWorker) pooledWorker.activeStderrRef.current = null;
    // Always schedule a background refill for the pool slot we used (cold spawn or pooled hit),
    // so the next caller of the same shape gets a warm worker. No-op when pool is disabled.
    if (poolEligible && !options.signal?.aborted) {
      const startupFn = (await sdkModulePromise as unknown as { startup?: SdkStartupFn }).startup;
      if (startupFn) void scheduleWarmRefill(pKey, sdkOptions, startupFn);
    }
  }
}

export async function cliSdkCompletion(
  model: string,
  options: ChatCompletionOptions & { toolExecutor?: ToolExecutor },
): Promise<ChatCompletionResult> {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let usageMetadata: Record<string, unknown> | undefined;
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let error: string | undefined;

  const streamOptions: ChatCompletionStreamOptions & { toolExecutor?: ToolExecutor } = {
    messages: options.messages,
    tools: options.tools,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    toolExecutor: options.toolExecutor,
    thinking: options.thinking,
    routingDecision: options.routingDecision,
    warmPoolLane: options.warmPoolLane,
    signal: options.signal,
  };

  for await (const event of cliSdkStream(model, streamOptions)) {
    switch (event.type) {
      case "text_delta":
        content += event.content;
        break;
      case "thinking_delta":
        break;
      case "tool_call_resolved":
        toolCalls.push({ id: event.toolCallId, name: event.toolName, arguments: event.arguments });
        break;
      case "usage":
        inputTokens = event.usage.inputTokens;
        outputTokens = event.usage.outputTokens;
        cacheReadTokens = event.usage.cacheReadTokens ?? 0;
        cacheWriteTokens = event.usage.cacheWriteTokens ?? 0;
        if (event.metadata) usageMetadata = event.metadata;
        break;
      case "error":
        error = event.error;
        break;
    }
  }

  if (error) {
    throw new Error(error);
  }

  // Mirror anthropicCompletion: when jsonMode is requested, normalise the raw
  // text through safeParseJSON (strips markdown fences, extracts embedded JSON)
  // and re-serialise so callers always receive clean JSON.
  if (options.jsonMode) {
    const { safeParseJSON } = await import("./utils/json-parse");
    const parsed = safeParseJSON(content, "cliSdkCompletion");
    if (parsed.ok) {
      content = JSON.stringify(parsed.data);
    } else {
      throw new Error(`CLI SDK JSON mode failed: ${parsed.error}. Model returned non-JSON: "${content.slice(0, 100)}"`);
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    },
    model,
    provider: "claude-cli",
    metadata: usageMetadata,
  };
}

// ---------------------------------------------------------------------------
// Voice CLI Pre-Warming
// ---------------------------------------------------------------------------
// One-shot per voice session. During voice start, once the system prompt is
// assembled, we spawn a CLI subprocess via startup() with delegating tool
// handlers. The warm handle is claimed on the first custom-LLM callback,
// binding the real tool executor before calling .query().
// ---------------------------------------------------------------------------

interface VoiceWarmHandle {
  warmQuery: SdkWarmHandle;
  executorRef: { current: ToolExecutor | null };
  sessionId: string;
  spawnedAt: number;
  consumed: boolean;
}

const VOICE_WARM_TTL_MS = 60_000;
const voiceWarmHandles = new Map<string, VoiceWarmHandle>();

export async function preWarmVoiceCli(opts: {
  sessionId: string;
  systemPrompt: string;
  model: string;
  toolDefs: ToolDefinition[];
  thinking?: import("./thinking-config").ResolvedThinking;
  connectorConfig?: ClaudeCliTierModelConfig;
}): Promise<void> {
  const sdkMod = await sdkModulePromise;
  const startupFn = (sdkMod as unknown as { startup?: SdkStartupFn }).startup;
  if (!startupFn) {
    log.warn("voice-warm: skipped — SDK does not export startup()");
    return;
  }

  const token = getSecretSync("CLAUDE_CODE_OAUTH_TOKEN");
  if (!token) {
    log.warn("voice-warm: skipped — no CLAUDE_CODE_OAUTH_TOKEN");
    return;
  }

  const executorRef: { current: ToolExecutor | null } = { current: null };

  // Build MCP tools with delegating handlers. Each handler delegates through
  // executorRef, which is set when the first custom-LLM callback claims the
  // warm handle. Safe because voice turns are strictly sequential per session.
  const sdkTools = opts.toolDefs.map((def) => {
    const zodShape = toolDefToZodShape(def);
    return sdkMod.tool(
      def.name,
      def.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        if (!executorRef.current) {
          const errText = `Error: Voice tool executor not yet bound for "${def.name}"`;
          return { content: [{ type: "text" as const, text: errText }], isError: true };
        }
        try {
          const result = await executorRef.current(def.name, args);
          return {
            content: [{ type: "text" as const, text: result.result }],
            isError: result.error || false,
          };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Tool execution error: ${errMsg}` }], isError: true };
        }
      },
    );
  });

  const mcpServer = sdkTools.length > 0
    ? sdkMod.createSdkMcpServer({ name: "xyz-tools", tools: sdkTools })
    : undefined;

  const sdkOptions = buildSdkOptions(opts.model, { thinking: opts.thinking, connectorConfig: opts.connectorConfig }, mcpServer, token);
  sdkOptions.systemPrompt = opts.systemPrompt;

  const spawnStart = Date.now();
  const warmQuery = await startupFn({ options: sdkOptions });
  const spawnMs = Date.now() - spawnStart;

  voiceWarmHandles.set(opts.sessionId, {
    warmQuery,
    executorRef,
    sessionId: opts.sessionId,
    spawnedAt: Date.now(),
    consumed: false,
  });

  log.debug(`voice-warm: spawned sessionId=${opts.sessionId} spawnMs=${spawnMs} tools=${opts.toolDefs.length}`);
}

/**
 * Claim a pre-warmed voice CLI handle. Sets the real tool executor on the
 * delegating ref and returns the warm handle for .query(). Returns null if
 * no valid handle exists (expired, already consumed, or never created).
 */
export function claimVoiceWarmHandle(
  sessionId: string,
  toolExecutor: ToolExecutor,
): SdkWarmHandle | null {
  const handle = voiceWarmHandles.get(sessionId);
  if (!handle) return null;

  if (handle.consumed || Date.now() - handle.spawnedAt > VOICE_WARM_TTL_MS) {
    try { handle.warmQuery.close(); } catch {}
    voiceWarmHandles.delete(sessionId);
    log.debug(`voice-warm: expired/consumed sessionId=${sessionId}`);
    return null;
  }

  handle.executorRef.current = toolExecutor;
  handle.consumed = true;
  voiceWarmHandles.delete(sessionId);
  log.debug(`voice-warm: claimed sessionId=${sessionId} age=${Date.now() - handle.spawnedAt}ms`);
  return handle.warmQuery;
}

/**
 * Clean up a warm handle when a voice session ends without claiming it.
 */
export function cleanupVoiceWarmHandle(sessionId: string): void {
  const handle = voiceWarmHandles.get(sessionId);
  if (!handle) return;
  try { handle.warmQuery.close(); } catch {}
  voiceWarmHandles.delete(sessionId);
  log.debug(`voice-warm: cleaned up sessionId=${sessionId}`);
}

// Background sweep: evict expired warm handles every 30s.
setInterval(() => {
  const now = Date.now();
  for (const [id, h] of voiceWarmHandles) {
    if (now - h.spawnedAt > VOICE_WARM_TTL_MS) {
      try { h.warmQuery.close(); } catch {}
      voiceWarmHandles.delete(id);
      log.debug(`voice-warm: sweep evicted sessionId=${id}`);
    }
  }
}, 30_000).unref?.();
