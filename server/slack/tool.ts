import type { ToolHandler } from "../tools/contracts";
import {
  inputFailure,
  permissionFailure,
  transientFailure,
  type ToolFailure,
  type ToolFailureCode,
} from "../tool-failure";
import type { AgentAuthorityContext, ToolInvocationOrigin } from "../agent-authority";
import type { SlackOutboundOrigin } from "./storage";

/**
 * Slack Mod public tool. status is provider-free readiness; send is the only mutation.
 * SQL and Slack HTTP stay in storage/client — this handler only normalizes and maps errors.
 */
export const slackToolHandler: ToolHandler = async (args) => {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action === "status") {
    try {
      const { getOutboundStatus } = await import("./storage");
      const status = await getOutboundStatus();
      return { result: JSON.stringify({ status }) };
    } catch (error) {
      return mapSlackToolError(error);
    }
  }

  if (action !== "send") {
    return {
      result: "Unknown slack action. Available: status, send",
      error: true,
      failure: inputFailure("slack_input_invalid", "unknown_action"),
    };
  }

  const to = typeof args.to === "string" ? args.to.trim() : "";
  if (to !== "person" && to !== "channel") {
    return {
      result: "slack.send requires to=person|channel",
      error: true,
      failure: inputFailure("slack_input_invalid", "to_required"),
    };
  }

  const text = typeof args.text === "string" ? args.text : "";
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : "";
  const personId = typeof args.personId === "string" && args.personId.trim()
    ? args.personId.trim()
    : undefined;
  const channelId = typeof args.channelId === "string" && args.channelId.trim()
    ? args.channelId.trim()
    : undefined;
  const authority = (args._authorityContext || {}) as AgentAuthorityContext;

  try {
    const { sendOnce } = await import("./storage");
    const receipt = await sendOnce({
      to: to as "person" | "channel",
      personId,
      channelId,
      text,
      idempotencyKey,
      origin: mapOutboundOrigin(authority),
      sessionId: typeof args._sessionId === "string" ? args._sessionId : undefined,
      runId: typeof authority.runtimeRunId === "string" ? authority.runtimeRunId : undefined,
      toolCallId: typeof args._toolCallId === "string" ? args._toolCallId : undefined,
    });
    return {
      result: JSON.stringify({
        status: receipt.status,
        outboundMessageId: receipt.id,
        destinationKind: receipt.destinationKind,
        deliveryChannel: receipt.deliveryChannel,
        deliveryTs: receipt.deliveryTs,
        replayed: receipt.replayed,
      }),
    };
  } catch (error) {
    return mapSlackToolError(error);
  }
};

function mapOutboundOrigin(authority: AgentAuthorityContext): SlackOutboundOrigin {
  const origin = authority.origin as ToolInvocationOrigin | undefined;
  if (origin === "timer") return "timer";
  if (origin === "hook") return "hook";
  if (authority.trustedDelegation === "plan") return "plan";
  if (origin === "autonomous" && authority.skillId) return "skill";
  if (origin === "autonomous") return "autonomous";
  return "interactive";
}

function mapSlackToolError(error: unknown): {
  result: string;
  error: true;
  failure: ToolFailure;
} {
  const code = error instanceof Error ? error.message : "slack_send_failed";
  const stable = code.slice(0, 80);

  const inputCodes = new Set<string>([
    "slack_person_unaddressed",
    "slack_not_mapped",
    "slack_channel_unconfigured",
    "slack_channel_mismatch",
    "slack_input_invalid",
    "slack_person_required",
    "slack_person_not_found",
    "slack_body_empty",
    "slack_body_too_long",
    "slack_idempotency_required",
    "slack_idempotency_conflict",
    "slack_idempotency_invalid",
  ]);
  if (inputCodes.has(stable)) {
    return {
      result: `Slack send failed: ${stable}`,
      error: true,
      failure: inputFailure(stable as ToolFailureCode, stable),
    };
  }

  if (
    stable === "slack_mod_inactive"
    || stable === "slack_installation_disabled"
    || stable === "slack_no_installation"
    || stable === "slack_unconfigured"
    || stable === "slack_credentials_unavailable"
  ) {
    return {
      result: `Slack send failed: ${stable}`,
      error: true,
      failure: permissionFailure("integration_not_configured", stable),
    };
  }

  if (stable === "slack_rate_limited" || stable === "slack_quota") {
    return {
      result: `Slack send failed: ${stable}`,
      error: true,
      failure: transientFailure(stable as ToolFailureCode, stable),
    };
  }

  if (stable.startsWith("slack_provider_") || stable === "slack_delivery_failed") {
    return {
      result: `Slack send failed: ${stable}`,
      error: true,
      failure: transientFailure("slack_provider_error", stable),
    };
  }

  return {
    result: `Slack send failed: ${stable}`,
    error: true,
    failure: inputFailure("slack_input_invalid", stable),
  };
}
