import { createHash, randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, runWithDatabaseTransaction } from "../db";
import { chatFileStorage } from "../chat-file-storage";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import type { AdmittedSlackEvent, SlackEventStatus } from "./contracts";

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
           account_id, owner_user_id, vault_id, allowed_channel_ids, enabled, status
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
           account_id, owner_user_id, vault_id, allowed_channel_ids, enabled, status
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
      account_id, owner_user_id, vault_id, allowed_channel_ids, enabled, status,
      created_by_user_id, updated_by_user_id
    )
    SELECT ${input.platformEnvironmentId}, pc.id, ${input.teamId}, ${input.apiAppId}, ${input.botUserId},
           ${principal.accountId!}, ${principal.userId!}, v.id,
           ${input.allowedChannelId ? sql`ARRAY[${input.allowedChannelId}]::text[]` : sql`ARRAY[]::text[]`}, FALSE, 'ready',
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
              account_id, owner_user_id, vault_id, allowed_channel_ids, enabled, status
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
              account_id, owner_user_id, vault_id, allowed_channel_ids, enabled, status
  `);
  if (result.rows.length !== 1) throw new Error("Slack installation not found");
  return mapInstallation(result.rows[0]);
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

export async function resolveSessionBinding(principal: Principal, installation: SlackInstallationRow, event: ClaimedSlackEvent, mappingId: string): Promise<{ bindingId: string; sessionId: string }> {
  if (event.eventType !== "message.im") throw new Error("slack_channel_session_deferred");
  const externalKey = `slack:${installation.id}:dm:${event.slackUserId}:${event.channelId}`;
  return runWithPrincipal(principal, async () => {
    const { resolveCurrentProfileIdentity } = await import("../profile-identity");
    const identity = await resolveCurrentProfileIdentity();
    const name = identity.userName?.trim()
      || (identity.userFirstName !== "there" ? identity.userFirstName : "")
      || "User";
    const title = `Slack DM: ${name}`;
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
        ${principal.userId!}, ${principal.accountId!}, ${principal.activeVaultId!}
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
    const accepted = await chatFileStorage.createUserMessageOnce(sessionId, event.body, clientTurnId);
    if (accepted.outcome === "session_not_found") throw new Error("slack_session_unavailable");
    await db.execute(sql`
      UPDATE slack_events SET mapping_id = ${mappingId}, binding_id = ${bindingId}, session_id = ${sessionId},
        client_turn_id = ${clientTurnId}, body = NULL, accepted_at = COALESCE(accepted_at, NOW()), updated_at = NOW()
      WHERE id = ${event.id} AND installation_id = ${event.installationId}
    `);
  });
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

function mapInstallation(row: Record<string, unknown>): SlackInstallationRow {
  return {
    id: String(row.id), platformEnvironmentId: Number(row.platform_environment_id), providerConnectionId: Number(row.provider_connection_id),
    teamId: String(row.team_id), apiAppId: String(row.api_app_id), botUserId: String(row.bot_user_id),
    accountId: String(row.account_id), ownerUserId: String(row.owner_user_id), vaultId: String(row.vault_id),
    allowedChannelIds: Array.isArray(row.allowed_channel_ids) ? row.allowed_channel_ids.map(String) : [],
    enabled: Boolean(row.enabled), status: String(row.status),
  };
}
