import { createHash, randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db, runWithDatabaseTransaction } from "../db";
import { chatFileStorage } from "../chat-file-storage";
import type { Principal } from "../principal";
import { getCurrentPrincipal, requireCurrentUserPrincipal, runWithPrincipal } from "../principal-context";
import { resolveCurrentProfileIdentity } from "../profile-identity";
import { peopleStorage, normalizePersonSlackUserId } from "../people-storage";
import { users } from "@shared/schema";
import type { AdmittedSlackEvent, SlackEventStatus } from "./contracts";
import { createLogger } from "../log";
import { getRuntimeIdentity } from "../runtime-identity";
import { hasActiveModAccess } from "../mods/mod-access";
import { loadSlackCredentials, postSlackMessage } from "./client";
import { markdownToSlackMrkdwn } from "./mrkdwn";

const outboundLog = createLogger("SlackOutbound");
const storageLog = createLogger("SlackStorage");

const OUTBOUND_BODY_MAX = 4000;
const OUTBOUND_DESTINATION_MIN_MS = 2_000;
const OUTBOUND_CALLER_LIMIT = 20;
const OUTBOUND_INSTALLATION_LIMIT = 30;
const OUTBOUND_MAX_ATTEMPTS = 3;
const OUTBOUND_RETRY_BASE_MS = 500;

export interface SlackInstallationRow {
  id: string;
  platformEnvironmentId: number;
  providerConnectionId: number;
  teamId: string;
  apiAppId: string;
  botUserId: string;
  accountId: string;
  ownerUserId: string;
  vaultId: string;
  allowedChannelIds: string[];
  allowedChannelName: string | null;
  enabled: boolean;
  status: string;
}

export interface ClaimedSlackEvent {
  id: string;
  installationId: string;
  eventId: string;
  eventType: string;
  channelId: string;
  rootTs: string;
  slackUserId: string;
  body: string;
  deliveryClientMsgId: string;
  attemptCount: number;
}

export function hashSlackContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function getRuntimeInstallations(platformEnvironmentId: number): Promise<SlackInstallationRow[]> {
  const result = await db.execute(sql`
    SELECT id, platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
           account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status
      FROM slack_installations
     WHERE platform_environment_id = ${platformEnvironmentId}
       AND enabled = TRUE
     ORDER BY created_at
     LIMIT 10
  `);
  return result.rows.map(mapInstallation);
}

export async function listOwnedInstallations(principal: Principal): Promise<SlackInstallationRow[]> {
  requireUser(principal);
  const result = await db.execute(sql`
    SELECT id, platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
           account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status
      FROM slack_installations
     WHERE account_id = ${principal.accountId!}
       AND owner_user_id = ${principal.userId!}
     ORDER BY created_at
     LIMIT 10
  `);
  return result.rows.map(mapInstallation);
}

export interface SlackMappingRow {
  installationId: string;
  slackUserId: string;
  mantraUserId: string;
  active: boolean;
}

export async function listOwnedMappings(principal: Principal): Promise<SlackMappingRow[]> {
  requireUser(principal);
  const result = await db.execute(sql`
    SELECT spm.installation_id, spm.slack_user_id, spm.mantra_user_id, spm.active
      FROM slack_principal_mappings spm
      JOIN slack_installations i ON i.id = spm.installation_id
     WHERE i.account_id = ${principal.accountId!}
       AND i.owner_user_id = ${principal.userId!}
     ORDER BY spm.created_at
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    installationId: String(row.installation_id),
    slackUserId: String(row.slack_user_id),
    mantraUserId: String(row.mantra_user_id),
    active: Boolean(row.active),
  }));
}

export async function createInstallation(principal: Principal, input: {
  platformEnvironmentId: number;
  providerConnectionId: number;
  teamId: string;
  apiAppId: string;
  botUserId: string;
  vaultId: string;
  allowedChannelId?: string;
}): Promise<SlackInstallationRow> {
  requireUser(principal);
  const result = await db.execute(sql`
    INSERT INTO slack_installations (
      platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
      account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status,
      created_by_user_id, updated_by_user_id
    )
    SELECT ${input.platformEnvironmentId}, pc.id, ${input.teamId}, ${input.apiAppId}, ${input.botUserId},
           ${principal.accountId!}, ${principal.userId!}, v.id,
           ${input.allowedChannelId ? sql`ARRAY[${input.allowedChannelId}]::text[]` : sql`ARRAY[]::text[]`},
           NULL, FALSE, 'ready',
           ${principal.userId!}, ${principal.userId!}
      FROM provider_connections pc
      JOIN vaults v ON v.id = ${input.vaultId}
     WHERE pc.id = ${input.providerConnectionId}
       AND pc.provider = 'slack'
       AND pc.status = 'active'
       AND pc.account_id = ${principal.accountId!}
       AND pc.owner_user_id = ${principal.userId!}
       AND pc.credential_envelope IS NOT NULL
       AND v.account_id = ${principal.accountId!}
       AND v.is_archived = FALSE
    RETURNING id, platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
              account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status
  `);
  if (result.rows.length !== 1) throw new Error("Slack installation authority prerequisites are not satisfied");
  return mapInstallation(result.rows[0]);
}

export async function setInstallationEnabled(principal: Principal, installationId: string, enabled: boolean): Promise<SlackInstallationRow> {
  requireUser(principal);
  const result = await db.execute(sql`
    UPDATE slack_installations
       SET enabled = ${enabled}, status = ${enabled ? "ready" : "disabled"},
           updated_by_user_id = ${principal.userId!}, updated_at = NOW()
     WHERE id = ${installationId}
       AND account_id = ${principal.accountId!}
       AND owner_user_id = ${principal.userId!}
    RETURNING id, platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
              account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status
  `);
  if (result.rows.length !== 1) throw new Error("Slack installation not found");
  return mapInstallation(result.rows[0]);
}

export async function rememberAllowedChannelName(installationId: string, channelId: string, rawName: string): Promise<SlackInstallationRow | null> {
  const channelName = normalizeSlackChannelName(rawName);
  if (!channelName) return null;
  const result = await db.execute(sql`
    UPDATE slack_installations
       SET allowed_channel_name = ${channelName}, updated_at = NOW()
     WHERE id = ${installationId}
       AND ${channelId} = ANY(allowed_channel_ids)
    RETURNING id, platform_environment_id, provider_connection_id, team_id, api_app_id, bot_user_id,
              account_id, owner_user_id, vault_id, allowed_channel_ids, allowed_channel_name, enabled, status
  `);
  return result.rows[0] ? mapInstallation(result.rows[0]) : null;
}

export async function upsertPrincipalMapping(principal: Principal, input: {
  installationId: string;
  slackUserId: string;
  mantraUserId: string;
}): Promise<void> {
  requireUser(principal);
  const result = await db.execute(sql`
    INSERT INTO slack_principal_mappings (
      installation_id, team_id, slack_user_id, mantra_user_id, account_id, vault_id,
      active, created_by_user_id, updated_by_user_id
    )
    SELECT i.id, i.team_id, ${input.slackUserId}, m.user_id, i.account_id, i.vault_id,
           TRUE, ${principal.userId!}, ${principal.userId!}
      FROM slack_installations i
      JOIN memberships m ON m.account_id = i.account_id AND m.user_id = ${input.mantraUserId}
      JOIN vaults v ON v.id = i.vault_id AND v.account_id = i.account_id AND v.is_archived = FALSE
     WHERE i.id = ${input.installationId}
       AND i.account_id = ${principal.accountId!}
       AND i.owner_user_id = ${principal.userId!}
    ON CONFLICT (installation_id, team_id, slack_user_id)
    DO UPDATE SET mantra_user_id = EXCLUDED.mantra_user_id, account_id = EXCLUDED.account_id,
                  vault_id = EXCLUDED.vault_id, active = TRUE,
                  updated_by_user_id = ${principal.userId!}, updated_at = NOW()
    RETURNING id
  `);
  if (result.rows.length !== 1) throw new Error("Slack mapping authority prerequisites are not satisfied");
}

export async function admitEvent(input: AdmittedSlackEvent): Promise<"inserted" | "duplicate"> {
  const result = await db.execute(sql`
    INSERT INTO slack_events (
      installation_id, event_id, envelope_id, event_type, channel_id, root_ts,
      slack_user_id, body, body_hash, status, delivery_client_msg_id
    ) VALUES (
      ${input.installationId}, ${input.eventId}, ${input.envelopeId}, ${input.eventType}, ${input.channelId},
      ${input.rootTs}, ${input.slackUserId}, ${input.body}, ${hashSlackContent(input.body)}, 'queued', ${randomUUID()}
    )
    ON CONFLICT (installation_id, event_id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length === 1 ? "inserted" : "duplicate";
}

export async function queuedCount(installationId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::integer AS count FROM slack_events
     WHERE installation_id = ${installationId} AND status IN ('queued','processing')
  `);
  return Number(result.rows[0]?.count ?? 0);
}

export async function claimEvent(installationId: string): Promise<ClaimedSlackEvent | null> {
  return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
    const result = await tx.execute(sql`
      WITH candidate AS (
        SELECT id FROM slack_events
         WHERE installation_id = ${installationId}
           AND (status = 'queued' OR (status = 'processing' AND lease_expires_at < NOW()))
           AND attempt_count < 3
         ORDER BY received_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE slack_events e
         SET status = 'processing', attempt_count = attempt_count + 1,
             lease_expires_at = NOW() + INTERVAL '130 seconds', updated_at = NOW()
        FROM candidate c
       WHERE e.id = c.id
      RETURNING e.id, e.installation_id, e.event_id, e.event_type, e.channel_id, e.root_ts,
                e.slack_user_id, e.body, e.delivery_client_msg_id, e.attempt_count
    `);
    const row = result.rows[0];
    if (!row || typeof row.body !== "string") return null;
    return {
      id: String(row.id), installationId: String(row.installation_id), eventId: String(row.event_id),
      eventType: String(row.event_type), channelId: String(row.channel_id), rootTs: String(row.root_ts),
      slackUserId: String(row.slack_user_id), body: row.body, deliveryClientMsgId: String(row.delivery_client_msg_id),
      attemptCount: Number(row.attempt_count),
    };
  }));
}

export async function resolveMappedPrincipal(event: ClaimedSlackEvent, installation: SlackInstallationRow): Promise<{ principal: Principal; mappingId: string }> {
  const result = await db.execute(sql`
    SELECT spm.id AS mapping_id, u.*, m.role AS membership_role
      FROM slack_principal_mappings spm
      JOIN slack_installations i ON i.id = spm.installation_id
      JOIN users u ON u.id = spm.mantra_user_id
      JOIN memberships m ON m.account_id = spm.account_id AND m.user_id = spm.mantra_user_id
      JOIN vaults v ON v.id = spm.vault_id AND v.account_id = spm.account_id AND v.is_archived = FALSE
     WHERE spm.installation_id = ${installation.id}
       AND spm.team_id = ${installation.teamId}
       AND spm.slack_user_id = ${event.slackUserId}
       AND spm.account_id = ${installation.accountId}
       AND spm.vault_id = ${installation.vaultId}
       AND spm.active = TRUE AND i.enabled = TRUE
     LIMIT 2
  `);
  if (result.rows.length !== 1) throw new Error("slack_mapping_unavailable");
  const row = result.rows[0];
  const { createUserSessionPrincipal } = await import("../principal");
  const principal = await createUserSessionPrincipal({
    id: String(row.id), email: String(row.email), password: String(row.password), role: String(row.role),
    inviteToken: row.invite_token as string | null, inviteExpires: row.invite_expires as Date | null,
    resetToken: row.reset_token as string | null, resetExpires: row.reset_expires as Date | null,
    activeVaultId: row.active_vault_id as string | null, visibleVaultIds: row.visible_vault_ids as string[] | null,
    createdAt: row.created_at as Date, passwordSignupAt: row.password_signup_at as Date | null,
  });
  if (event.eventType !== "message.im") {
    return {
      mappingId: String(row.mapping_id),
      principal: { ...principal, accountId: installation.accountId, visibleVaultIds: [installation.vaultId], activeVaultId: installation.vaultId },
    };
  }
  return { mappingId: String(row.mapping_id), principal };
}

/**
 * After an admitted inbound event resolves an active principal mapping, fill the mapped
 * User's cabinet self Person `social_profiles.slack` once when empty.
 * Locator only — never creates People, never overwrites, never authorizes send.
 */
export async function stampSelfPersonSlackLocatorIfEmpty(
  principal: Principal,
  slackUserId: string,
): Promise<"stamped" | "already_set" | "no_self_person" | "invalid_id"> {
  return runWithPrincipal(principal, async () => {
    let normalized: string;
    try {
      normalized = normalizePersonSlackUserId(slackUserId);
    } catch {
      return "invalid_id";
    }
    const people = await peopleStorage.listPeople();
    const self = people.find((entry) => entry.cabinetLevel === "user");
    if (!self) return "no_self_person";
    const existing =
      typeof self.socialProfiles?.slack === "string" ? self.socialProfiles.slack.trim() : "";
    if (existing) return "already_set";
    await peopleStorage.updatePerson(self.id, {
      socialProfiles: {
        ...(self.socialProfiles || {}),
        slack: normalized,
      },
    });
    storageLog.info("Stamped self Person Slack locator from inbound mapping", {
      personId: self.id,
    });
    return "stamped";
  });
}

async function resolveInstallationOwnerPrincipal(installation: SlackInstallationRow): Promise<Principal> {
  const [owner] = await db.select().from(users).where(eq(users.id, installation.ownerUserId)).limit(1);
  if (!owner) throw new Error("slack_installation_owner_unavailable");
  const { createUserSessionPrincipal } = await import("../principal");
  const principal = await createUserSessionPrincipal(owner);
  return {
    ...principal,
    accountId: installation.accountId,
    visibleVaultIds: [installation.vaultId],
    activeVaultId: installation.vaultId,
  };
}

export async function resolveSessionBinding(principal: Principal, installation: SlackInstallationRow, event: ClaimedSlackEvent, mappingId: string): Promise<{ bindingId: string; sessionId: string }> {
  const isMention = event.eventType === "app_mention";
  const externalKey = isMention
    ? `slack:${installation.id}:channel:${event.channelId}`
    : `slack:${installation.id}:dm:${event.slackUserId}:${event.channelId}`;
  const sessionPrincipal = isMention ? await resolveInstallationOwnerPrincipal(installation) : principal;
  return runWithPrincipal(sessionPrincipal, async () => {
    const title = isMention
      ? `Slack Channel: ${formatSlackChannelTitle(installation.allowedChannelName, event.channelId)}`
      : `Slack DM: ${await resolveSlackSpeakerName()}`;
    const session = await chatFileStorage.createSessionOnce(title, externalKey, undefined, {
      sessionType: "user",
      protectTitle: true,
    });
    if (session.outcome === "existing" && session.session.title !== title) {
      await chatFileStorage.updateSessionTitle(session.session.id, title, { source: "manual" });
    }
    const result = await db.execute(sql`
      INSERT INTO slack_session_bindings (
        installation_id, mapping_id, external_key, channel_id, root_ts, session_id,
        owner_user_id, account_id, vault_id
      ) VALUES (
        ${installation.id}, ${mappingId}, ${externalKey}, ${event.channelId}, ${event.rootTs}, ${session.session.id},
        ${sessionPrincipal.userId!}, ${sessionPrincipal.accountId!}, ${sessionPrincipal.activeVaultId!}
      )
      ON CONFLICT (installation_id, external_key)
      DO UPDATE SET updated_at = NOW()
      RETURNING id, session_id
    `);
    return { bindingId: String(result.rows[0].id), sessionId: String(result.rows[0].session_id) };
  });
}

export async function acceptCanonicalTurn(principal: Principal, event: ClaimedSlackEvent, bindingId: string, sessionId: string, mappingId: string): Promise<void> {
  await runWithPrincipal(principal, async () => {
    const clientTurnId = `slack:${event.eventId}`;
    const speaker = event.eventType === "app_mention"
      ? {
          key: `slack:${event.slackUserId}`,
          ...(await resolveSlackSpeaker()),
        }
      : undefined;
    const accepted = await chatFileStorage.createUserMessageOnce(
      sessionId,
      event.body,
      clientTurnId,
      undefined,
      undefined,
      undefined,
      undefined,
      speaker,
    );
    if (accepted.outcome === "session_not_found") throw new Error("slack_session_unavailable");
    await db.execute(sql`
      UPDATE slack_events SET mapping_id = ${mappingId}, binding_id = ${bindingId}, session_id = ${sessionId},
        client_turn_id = ${clientTurnId}, body = NULL, accepted_at = COALESCE(accepted_at, NOW()), updated_at = NOW()
      WHERE id = ${event.id} AND installation_id = ${event.installationId}
    `);
  });
}

async function resolveSlackSpeakerPerson(): Promise<{ id: string; name: string } | null> {
  const principal = getCurrentPrincipal();
  if (!principal?.userId) return null;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  const email = user?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  try {
    const person = await peopleStorage.getPersonByEmail(email);
    return person ? { id: person.id, name: person.name } : null;
  } catch {
    return null;
  }
}

async function resolveSlackSpeaker(): Promise<{ label: string; personId?: string }> {
  const identity = await resolveCurrentProfileIdentity();
  const person = await resolveSlackSpeakerPerson();
  return {
    label: person?.name || identity.userName || identity.userFirstName,
    ...(person ? { personId: person.id } : {}),
  };
}

async function resolveSlackSpeakerName(): Promise<string> {
  return (await resolveSlackSpeaker()).label;
}

export async function settleEvent(eventId: string, status: SlackEventStatus, input: { response?: string; deliveryState?: string; deliveryTs?: string; failureCode?: string } = {}): Promise<void> {
  await db.execute(sql`
    UPDATE slack_events SET status = ${status}, response_hash = ${input.response ? hashSlackContent(input.response) : null},
      delivery_state = COALESCE(${input.deliveryState ?? null}, delivery_state),
      delivery_ts = COALESCE(${input.deliveryTs ?? null}, delivery_ts), failure_code = ${input.failureCode ?? null},
      lease_expires_at = NULL, completed_at = CASE WHEN ${status} IN ('completed','failed','delivery_failed','blocked') THEN NOW() ELSE completed_at END,
      updated_at = NOW()
    WHERE id = ${eventId}
  `);
}

function requireUser(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) throw new Error("Slack storage requires a user principal");
}

function normalizeSlackChannelName(value?: string): string | null {
  const cleaned = value?.trim().replace(/^#+/, "").toLowerCase();
  if (!cleaned || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(cleaned)) return null;
  return `#${cleaned}`;
}

function formatSlackChannelTitle(name: string | null | undefined, channelId: string): string {
  return name?.trim() || channelId;
}

function mapInstallation(row: Record<string, unknown>): SlackInstallationRow {
  return {
    id: String(row.id), platformEnvironmentId: Number(row.platform_environment_id), providerConnectionId: Number(row.provider_connection_id),
    teamId: String(row.team_id), apiAppId: String(row.api_app_id), botUserId: String(row.bot_user_id),
    accountId: String(row.account_id), ownerUserId: String(row.owner_user_id), vaultId: String(row.vault_id),
    allowedChannelIds: Array.isArray(row.allowed_channel_ids) ? row.allowed_channel_ids.map(String) : [],
    allowedChannelName: typeof row.allowed_channel_name === "string" ? row.allowed_channel_name : null,
    enabled: Boolean(row.enabled), status: String(row.status),
  };
}

// ─── Outbound tool path ─────────────────────────────────────────────────────

export type SlackOutboundStatus =
  | "inactive_mod"
  | "no_installation"
  | "disabled"
  | "unconfigured"
  | "ready";

export type SlackOutboundOrigin =
  | "interactive"
  | "autonomous"
  | "timer"
  | "hook"
  | "skill"
  | "plan";

export interface SlackOutboundSendInput {
  to: "person" | "channel";
  personId?: string;
  channelId?: string;
  text: string;
  idempotencyKey: string;
  origin: SlackOutboundOrigin;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
}

export interface SlackOutboundReceipt {
  id: string;
  status: "sent";
  destinationKind: "dm" | "channel";
  deliveryChannel: string;
  deliveryTs: string;
  replayed: boolean;
}

/** Provider-free readiness discriminant for slack.status. Never decrypts tokens. */
export async function getOutboundStatus(): Promise<SlackOutboundStatus> {
  const principal = requireCurrentUserPrincipal();
  if (!(await hasActiveModAccess(principal, "slack"))) return "inactive_mod";

  const identity = await getRuntimeIdentity();
  if (!identity.platformEnvironmentId) return "no_installation";

  const result = await db.execute(sql`
    SELECT enabled, status, allowed_channel_ids, provider_connection_id
      FROM slack_installations
     WHERE platform_environment_id = ${identity.platformEnvironmentId}
       AND account_id = ${principal.accountId}
     ORDER BY enabled DESC, created_at ASC
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return "no_installation";
  if (!row.enabled) return "disabled";
  if (String(row.status) === "unconfigured" || row.provider_connection_id == null) return "unconfigured";
  return "ready";
}

/**
 * Canonical outbound send. Revalidates Mod + installation + mapping/allowlist +
 * Person visibility, enforces ceilings, claims the outbox, then posts via the
 * existing client. Tool handlers must not SQL or call Slack HTTP directly.
 */
export async function sendOnce(input: SlackOutboundSendInput): Promise<SlackOutboundReceipt> {
  const principal = requireCurrentUserPrincipal();
  const text = input.text.trim();
  if (!text) throw new Error("slack_body_empty");
  if ([...text].length > OUTBOUND_BODY_MAX) throw new Error("slack_body_too_long");
  // Model/skill text is Markdown. Slack renders mrkdwn. Convert at the sole
  // outbound mutation boundary so inbound replies and slack.send share one converter.
  const rendered = markdownToSlackMrkdwn(text).replace(/\s+$/g, "").trim() || text;
  if ([...rendered].length > OUTBOUND_BODY_MAX) throw new Error("slack_body_too_long");

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    throw new Error("slack_idempotency_invalid");
  }

  if (!(await hasActiveModAccess(principal, "slack"))) throw new Error("slack_mod_inactive");

  const identity = await getRuntimeIdentity();
  if (!identity.platformEnvironmentId) throw new Error("slack_no_installation");

  const installations = await getRuntimeInstallations(identity.platformEnvironmentId);
  const installation = installations.find(
    (row) => row.accountId === principal.accountId && row.enabled,
  );
  if (!installation) {
    const any = await db.execute(sql`
      SELECT enabled FROM slack_installations
       WHERE platform_environment_id = ${identity.platformEnvironmentId}
         AND account_id = ${principal.accountId}
       LIMIT 1
    `);
    if (any.rows[0] && any.rows[0].enabled === false) throw new Error("slack_installation_disabled");
    throw new Error("slack_no_installation");
  }

  const bodyHash = hashSlackContent(text);
  const deliveryClientMsgId = deterministicOutboundClientMsgId(installation.id, idempotencyKey);

  let destinationKind: "dm" | "channel";
  let destinationSlackId: string;
  let personId: string | null = null;
  let mappingId: string | null = null;

  if (input.to === "person") {
    if (!input.personId?.trim()) throw new Error("slack_person_required");
    const person = await peopleStorage.getPerson(input.personId.trim());
    if (!person) throw new Error("slack_person_not_found");
    personId = person.id;

    const rawSlack = person.socialProfiles?.slack;
    if (typeof rawSlack !== "string" || !rawSlack.trim()) throw new Error("slack_person_unaddressed");
    destinationSlackId = normalizePersonSlackUserId(rawSlack);
    destinationKind = "dm";

    const mapping = await db.execute(sql`
      SELECT id FROM slack_principal_mappings
       WHERE installation_id = ${installation.id}
         AND team_id = ${installation.teamId}
         AND slack_user_id = ${destinationSlackId}
         AND active = TRUE
       LIMIT 1
    `);
    if (mapping.rows.length !== 1) throw new Error("slack_not_mapped");
    mappingId = String(mapping.rows[0].id);
  } else {
    const allowed = installation.allowedChannelIds[0];
    if (!allowed || !/^C[A-Z0-9]{1,31}$/.test(allowed)) throw new Error("slack_channel_unconfigured");
    if (input.channelId && input.channelId.trim() !== allowed) throw new Error("slack_channel_mismatch");
    destinationKind = "channel";
    destinationSlackId = allowed;
  }

  // Replay of same key + same body returns the existing sent receipt.
  const existing = await db.execute(sql`
    SELECT id, status, body_hash, delivery_channel, delivery_ts, destination_kind
      FROM slack_outbound_messages
     WHERE installation_id = ${installation.id}
       AND idempotency_key = ${idempotencyKey}
     LIMIT 1
  `);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (String(row.body_hash) !== bodyHash) throw new Error("slack_idempotency_conflict");
    if (String(row.status) === "sent" && row.delivery_channel && row.delivery_ts) {
      return {
        id: String(row.id),
        status: "sent",
        destinationKind: String(row.destination_kind) as "dm" | "channel",
        deliveryChannel: String(row.delivery_channel),
        deliveryTs: String(row.delivery_ts),
        replayed: true,
      };
    }
    if (String(row.status) === "sending") {
      // Another worker may be in flight; treat as conflict rather than double-post.
      throw new Error("slack_idempotency_conflict");
    }
  }

  await enforceOutboundCeilings(installation.id, principal.userId, destinationSlackId);

  const vaultId = principal.activeVaultId || installation.vaultId;
  const insert = await db.execute(sql`
    INSERT INTO slack_outbound_messages (
      installation_id, idempotency_key, origin, caller_user_id, account_id, vault_id,
      session_id, run_id, tool_call_id, destination_kind, destination_slack_id,
      person_id, mapping_id, body, body_hash, status, delivery_client_msg_id, attempt_count
    ) VALUES (
      ${installation.id}, ${idempotencyKey}, ${input.origin}, ${principal.userId}, ${principal.accountId}, ${vaultId},
      ${input.sessionId ?? null}, ${input.runId ?? null}, ${input.toolCallId ?? null},
      ${destinationKind}, ${destinationSlackId},
      ${personId}, ${mappingId}, ${text}, ${bodyHash}, 'sending', ${deliveryClientMsgId}::uuid, 0
    )
    ON CONFLICT (installation_id, idempotency_key)
    DO NOTHING
    RETURNING id
  `);

  let outboundId: string;
  if (insert.rows[0]) {
    outboundId = String(insert.rows[0].id);
  } else {
    // Lost the insert race — re-read and return sent receipt or fail closed.
    const raced = await db.execute(sql`
      SELECT id, status, body_hash, delivery_channel, delivery_ts, destination_kind
        FROM slack_outbound_messages
       WHERE installation_id = ${installation.id}
         AND idempotency_key = ${idempotencyKey}
       LIMIT 1
    `);
    const row = raced.rows[0];
    if (!row) throw new Error("slack_send_failed");
    if (String(row.body_hash) !== bodyHash) throw new Error("slack_idempotency_conflict");
    if (String(row.status) === "sent" && row.delivery_channel && row.delivery_ts) {
      return {
        id: String(row.id),
        status: "sent",
        destinationKind: String(row.destination_kind) as "dm" | "channel",
        deliveryChannel: String(row.delivery_channel),
        deliveryTs: String(row.delivery_ts),
        replayed: true,
      };
    }
    throw new Error("slack_idempotency_conflict");
  }

  // Dual kill switch immediately before provider dispatch.
  if (!(await hasActiveModAccess(principal, "slack"))) {
    await markOutboundBlocked(outboundId, "slack_mod_inactive");
    throw new Error("slack_mod_inactive");
  }
  const live = await db.execute(sql`
    SELECT enabled FROM slack_installations WHERE id = ${installation.id} LIMIT 1
  `);
  if (!live.rows[0]?.enabled) {
    await markOutboundBlocked(outboundId, "slack_installation_disabled");
    throw new Error("slack_installation_disabled");
  }

  let lastError = "slack_delivery_failed";
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt += 1) {
    await db.execute(sql`
      UPDATE slack_outbound_messages
         SET attempt_count = ${attempt}, status = 'sending', updated_at = NOW()
       WHERE id = ${outboundId}
    `);
    try {
      const credentials = await loadSlackCredentials(installation);
      const receipt = await postSlackMessage(credentials, {
        channel: destinationSlackId,
        text: rendered,
        clientMsgId: deliveryClientMsgId,
      });
      await db.execute(sql`
        UPDATE slack_outbound_messages
           SET status = 'sent', body = NULL, delivery_channel = ${receipt.channel},
               delivery_ts = ${receipt.ts}, failure_code = NULL,
               sent_at = NOW(), updated_at = NOW()
         WHERE id = ${outboundId}
      `);
      outboundLog.info(
        `sent outboundId=${outboundId} kind=${destinationKind} attempt=${attempt}`,
      );
      return {
        id: outboundId,
        status: "sent",
        destinationKind,
        deliveryChannel: receipt.channel,
        deliveryTs: receipt.ts,
        replayed: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 120) : "slack_delivery_failed";
      outboundLog.warn(
        `outbound attempt failed outboundId=${outboundId} attempt=${attempt} code=${lastError}`,
      );
      if (attempt < OUTBOUND_MAX_ATTEMPTS && isRetryableSlackProviderError(lastError)) {
        await sleep(OUTBOUND_RETRY_BASE_MS * attempt);
        continue;
      }
      break;
    }
  }

  await db.execute(sql`
    UPDATE slack_outbound_messages
       SET status = 'failed', failure_code = ${lastError}, updated_at = NOW()
     WHERE id = ${outboundId}
  `);
  // Expire failed body after 24h is retention-job territory; null immediately on permanent input-class fails.
  if (
    lastError === "slack_person_unaddressed"
    || lastError === "slack_not_mapped"
    || lastError === "slack_channel_unconfigured"
    || lastError === "slack_channel_mismatch"
  ) {
    await db.execute(sql`
      UPDATE slack_outbound_messages SET body = NULL, updated_at = NOW() WHERE id = ${outboundId}
    `);
  }
  throw new Error(lastError.startsWith("slack_") ? lastError : "slack_delivery_failed");
}

async function enforceOutboundCeilings(
  installationId: string,
  callerUserId: string,
  destinationSlackId: string,
): Promise<void> {
  const destWindow = await db.execute(sql`
    SELECT created_at FROM slack_outbound_messages
     WHERE installation_id = ${installationId}
       AND destination_slack_id = ${destinationSlackId}
       AND status IN ('sending','sent')
     ORDER BY created_at DESC
     LIMIT 1
  `);
  const lastDest = destWindow.rows[0]?.created_at
    ? new Date(String(destWindow.rows[0].created_at)).getTime()
    : 0;
  if (lastDest && Date.now() - lastDest < OUTBOUND_DESTINATION_MIN_MS) {
    throw new Error("slack_rate_limited");
  }

  const callerCount = await db.execute(sql`
    SELECT COUNT(*)::integer AS count FROM slack_outbound_messages
     WHERE caller_user_id = ${callerUserId}
       AND status IN ('sending','sent')
       AND created_at > NOW() - INTERVAL '10 minutes'
  `);
  if (Number(callerCount.rows[0]?.count ?? 0) >= OUTBOUND_CALLER_LIMIT) {
    throw new Error("slack_quota");
  }

  const installCount = await db.execute(sql`
    SELECT COUNT(*)::integer AS count FROM slack_outbound_messages
     WHERE installation_id = ${installationId}
       AND status IN ('sending','sent')
       AND created_at > NOW() - INTERVAL '10 minutes'
  `);
  if (Number(installCount.rows[0]?.count ?? 0) >= OUTBOUND_INSTALLATION_LIMIT) {
    throw new Error("slack_quota");
  }
}

async function markOutboundBlocked(id: string, code: string): Promise<void> {
  await db.execute(sql`
    UPDATE slack_outbound_messages
       SET status = 'blocked', failure_code = ${code}, body = NULL, updated_at = NOW()
     WHERE id = ${id}
  `);
}

function deterministicOutboundClientMsgId(installationId: string, idempotencyKey: string): string {
  // UUID v5-style: SHA-1 of namespace+name, version/variant bits set. Stable across retries.
  const ns = createHash("sha1").update(`slack-outbound:${installationId}`).digest();
  const hash = createHash("sha1").update(ns).update(idempotencyKey).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRetryableSlackProviderError(code: string): boolean {
  return (
    code.includes("ratelimited")
    || code.includes("rate_limited")
    || code.includes("timeout")
    || code.includes("http_5")
    || code.includes("provider_fatal")
    || code === "slack_provider_invalid_json"
    || code === "slack_delivery_receipt_invalid"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
