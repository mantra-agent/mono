import type WebSocket from "ws";
import { createLogger } from "../log";
import { getRuntimeIdentity } from "../runtime-identity";
import { hasActiveModAccess } from "../mods/mod-access";
import { createUserSessionPrincipal } from "../principal";
import { users } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  SLACK_EVENT_DEADLINE_MS,
  SLACK_FAILURE_TEXT,
  SLACK_INPUT_CHAR_LIMIT,
  SLACK_PROGRESS_TEXT,
  SLACK_QUEUE_LIMIT,
  isSlackSocketEnvelope,
  normalizeSlackText,
} from "./contracts";
import {
  acceptCanonicalTurn,
  admitEvent,
  claimEvent,
  getRuntimeInstallations,
  queuedCount,
  rememberAllowedChannelName,
  resolveMappedPrincipal,
  resolveSessionBinding,
  settleEvent,
  stampSelfPersonSlackLocatorIfEmpty,
  type ClaimedSlackEvent,
  type SlackInstallationRow,
} from "./storage";
import {
  getSlackChannelName,
  loadSlackCredentials,
  openSlackSocket,
  postSlackMessage,
  updateSlackMessage,
  verifySlackIdentity,
  type SlackCredentialBundle,
} from "./client";
import { executeSlackTurn } from "./turn-service";

const log = createLogger("SlackWorker");

async function refreshAllowedChannelName(
  installation: SlackInstallationRow,
  credentials: SlackCredentialBundle,
  channelId: string,
): Promise<SlackInstallationRow> {
  if (!installation.allowedChannelIds.includes(channelId)) return installation;
  try {
    const name = await getSlackChannelName(credentials, channelId);
    if (!name) return installation;
    return await rememberAllowedChannelName(installation.id, channelId, name) ?? installation;
  } catch (error) {
    log.warn("Slack channel name lookup failed; keeping cached title", {
      installationId: installation.id,
      reason: error instanceof Error ? error.message.slice(0, 80) : "unknown",
    });
    return installation;
  }
}

// Connection failures that represent a permanent, unrecoverable installation
// state: the stored Slack identity no longer matches the installation, so
// reconnecting cannot succeed without operator reauthorization. These must not
// be hard-retried on the 30s refresh cadence.
const PERMANENT_CONNECTION_FAILURES = new Set(["slack_identity_mismatch"]);

const sockets = new Map<string, WebSocket>();
// Installations parked after a permanent connection failure. Skipped on refresh
// until the installation is disabled/re-enabled (i.e. reauthorized), which is the
// only in-process signal that its authorization may have changed.
const needsReauth = new Set<string>();
// Installations that failed to connect for a non-permanent reason are retried
// with exponential backoff rather than on every 30s tick, so a single bad
// installation cannot mint a storm of identical error logs. The first failure
// of an episode logs at error; subsequent retries log at warn until it recovers.
const RECONNECT_BACKOFF_BASE_MS = 30_000;
const RECONNECT_BACKOFF_CAP_MS = 30 * 60_000;
const connectBackoff = new Map<string, { failures: number; nextAttemptAt: number }>();
let stopped = false;
let refreshTimer: NodeJS.Timeout | null = null;
let processing = false;
// refreshInstallations runs every 30s; emit the missing-identity warn once per boot.
let missingIdentityWarned = false;

export async function startSlackWorker(): Promise<void> {
  stopped = false;
  await refreshInstallations();
  refreshTimer = setInterval(() => void refreshInstallations(), 30_000);
  refreshTimer.unref?.();
}

export async function stopSlackWorker(): Promise<void> {
  stopped = true;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  for (const socket of sockets.values()) socket.close(1000, "Mantra shutdown");
  sockets.clear();
  needsReauth.clear();
  connectBackoff.clear();
}

async function refreshInstallations(): Promise<void> {
  if (stopped) return;
  const identity = await getRuntimeIdentity();
  if (!identity.platformEnvironmentId) {
    if (!missingIdentityWarned) {
      missingIdentityWarned = true;
      log.warn("Slack worker idle: runtime identity has no Platform Environment", {
        environmentName: identity.environmentName,
        serviceName: identity.serviceName,
        servingHost: identity.servingHost,
        gitCommit: identity.gitCommit,
      });
    }
    return;
  }
  missingIdentityWarned = false;
  const installations = await getRuntimeInstallations(identity.platformEnvironmentId);
  const enabled = new Set(installations.map((installation) => installation.id));
  for (const [id, socket] of sockets) {
    if (!enabled.has(id)) { socket.close(1000, "Slack installation disabled"); sockets.delete(id); }
  }
  // Drop parked installations once disabled/removed so a re-enable (after reauth) retries.
  for (const id of needsReauth) {
    if (!enabled.has(id)) needsReauth.delete(id);
  }
  // Drop backoff state once disabled/removed so a re-enable retries immediately.
  for (const id of connectBackoff.keys()) {
    if (!enabled.has(id)) connectBackoff.delete(id);
  }
  const now = Date.now();
  for (const installation of installations) {
    if (sockets.has(installation.id) || needsReauth.has(installation.id)) continue;
    const backoff = connectBackoff.get(installation.id);
    if (backoff && backoff.nextAttemptAt > now) continue;
    void connectInstallation(installation);
  }
  void drainQueue(installations);
}

async function connectInstallation(installation: SlackInstallationRow): Promise<void> {
  try {
    if (!(await installationActive(installation))) return;
    const credentials = await loadSlackCredentials(installation);
    await verifySlackIdentity(credentials, installation);
    const socket = await openSlackSocket(credentials);
    sockets.set(installation.id, socket);
    socket.on("message", (data) => void handleSocketMessage(installation, credentials, socket, data.toString()));
    socket.on("close", () => sockets.delete(installation.id));
    socket.on("error", (error) => log.warn("Slack socket degraded", { installationId: installation.id, errorName: error.name }));
    connectBackoff.delete(installation.id);
    log.info("Slack socket connected", { installationId: installation.id });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (PERMANENT_CONNECTION_FAILURES.has(code)) {
      needsReauth.add(installation.id);
      connectBackoff.delete(installation.id);
      log.warn("Slack installation requires reauthorization; halting reconnect attempts until re-enabled", { installationId: installation.id, reason: code });
      return;
    }
    const failures = (connectBackoff.get(installation.id)?.failures ?? 0) + 1;
    const delay = Math.min(RECONNECT_BACKOFF_BASE_MS * 2 ** (failures - 1), RECONNECT_BACKOFF_CAP_MS);
    connectBackoff.set(installation.id, { failures, nextAttemptAt: Date.now() + delay });
    if (failures === 1) {
      log.error("Slack installation connection failed", error instanceof Error ? error : new Error(String(error)), { installationId: installation.id });
    } else {
      log.warn("Slack installation still failing to connect; backing off", { installationId: installation.id, failures, retryInMs: delay, reason: code.slice(0, 80) });
    }
  }
}

async function handleSocketMessage(installation: SlackInstallationRow, _credentials: SlackCredentialBundle, socket: WebSocket, raw: string): Promise<void> {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!isSlackSocketEnvelope(parsed)) return;
  const event = parsed.payload.event;
  if (parsed.payload.team_id !== installation.teamId || parsed.payload.api_app_id !== installation.apiAppId) return;
  if (event.bot_id || event.user === installation.botUserId || event.subtype) return;
  const isDm = event.type === "message" && event.channel_type === "im";
  const isMention = event.type === "app_mention" && installation.allowedChannelIds.includes(event.channel!);
  if (!isDm && !isMention) return;
  const body = normalizeSlackText(event.text!, installation.botUserId);
  if (!body || body.length > SLACK_INPUT_CHAR_LIMIT) return;
  if (await queuedCount(installation.id) >= SLACK_QUEUE_LIMIT) return;
  const admitted = await admitEvent({
    installationId: installation.id,
    eventId: parsed.payload.event_id,
    envelopeId: parsed.envelope_id,
    eventType: isDm ? "message.im" : "app_mention",
    channelId: event.channel!, rootTs: event.thread_ts || event.ts!, slackUserId: event.user!, body,
  });
  socket.send(JSON.stringify({ envelope_id: parsed.envelope_id }));
  log.debug("Slack envelope durably acknowledged", { installationId: installation.id, outcome: admitted });
  void drainQueue([installation]);
}

async function drainQueue(installations: SlackInstallationRow[]): Promise<void> {
  if (processing || stopped) return;
  processing = true;
  try {
    for (const installation of installations) {
      let event: ClaimedSlackEvent | null;
      while (!stopped && (event = await claimEvent(installation.id))) {
        await processEvent(installation, event);
      }
    }
  } finally {
    processing = false;
  }
}

async function processEvent(installation: SlackInstallationRow, event: ClaimedSlackEvent): Promise<void> {
  let credentials: SlackCredentialBundle | null = null;
  let progressTs: string | null = null;
  try {
    if (!(await installationActive(installation))) throw new Error("slack_mod_or_installation_inactive");
    credentials = await loadSlackCredentials(installation);
    if (event.eventType === "app_mention") {
      installation = await refreshAllowedChannelName(installation, credentials, event.channelId);
    }
    const mapped = await resolveMappedPrincipal(event, installation);
    try {
      const stamp = await stampSelfPersonSlackLocatorIfEmpty(mapped.principal, event.slackUserId);
      if (stamp === "no_self_person" || stamp === "invalid_id") {
        log.warn("Slack self locator stamp skipped", { eventRowId: event.id, outcome: stamp });
      }
    } catch (error) {
      log.warn("Slack self locator stamp soft-failed; inbound continues", {
        eventRowId: event.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    const binding = await resolveSessionBinding(mapped.principal, installation, event, mapped.mappingId);
    await acceptCanonicalTurn(mapped.principal, event, binding.bindingId, binding.sessionId, mapped.mappingId);
    if (!(await installationActive(installation))) throw new Error("slack_mod_or_installation_inactive");
    const receipt = await postSlackMessage(credentials, {
      channel: event.channelId,
      ...(event.eventType === "app_mention" ? { threadTs: event.rootTs } : {}),
      text: SLACK_PROGRESS_TEXT,
      clientMsgId: event.deliveryClientMsgId,
    });
    progressTs = receipt.ts;
    await settleEvent(event.id, "processing", { deliveryState: "progress", deliveryTs: receipt.ts });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("slack_turn_deadline")), SLACK_EVENT_DEADLINE_MS);
    timeout.unref?.();
    let response: string;
    try {
      response = await executeSlackTurn(mapped.principal, {
        sessionId: binding.sessionId,
        eventId: event.eventId,
        eventType: event.eventType,
        content: typeof event.body === "string" ? event.body : "",
        signal: controller.signal,
      });
    }
    finally { clearTimeout(timeout); }
    if (!(await installationActive(installation))) throw new Error("slack_mod_or_installation_inactive");
    await updateSlackMessage(credentials, { channel: event.channelId, ts: receipt.ts, text: response });
    await settleEvent(event.id, "completed", { response, deliveryState: "final", deliveryTs: receipt.ts });
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : "slack_event_failed";
    if (credentials && progressTs && await installationActive(installation).catch(() => false)) {
      await updateSlackMessage(credentials, { channel: event.channelId, ts: progressTs, text: SLACK_FAILURE_TEXT }).catch(() => undefined);
    }
    await settleEvent(event.id, progressTs ? "failed" : "delivery_failed", { deliveryState: progressTs ? "failure" : "failed", deliveryTs: progressTs ?? undefined, failureCode: code });
    log.error("Slack event failed", error instanceof Error ? error : new Error(String(error)), { eventRowId: event.id, installationId: installation.id });
  }
}

async function installationActive(installation: SlackInstallationRow): Promise<boolean> {
  const [owner] = await db.select().from(users).where(eq(users.id, installation.ownerUserId)).limit(1);
  if (!owner) return false;
  const principal = await createUserSessionPrincipal(owner);
  return principal.accountId === installation.accountId && await hasActiveModAccess(principal, "slack");
}
