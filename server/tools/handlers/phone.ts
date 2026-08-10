import type { ToolHandler } from "../contracts";

/**
 * Phone-call handler extracted from bridge-tools.ts. Prepares or confirms a
 * user-initiated outbound call, delegating to the canonical phone/outbound
 * boundary. Behavior and result shapes are preserved verbatim; public identity,
 * ownership/composition, and the executeTool invocation/authority boundary
 * remain owned by their canonical modules.
 */
export const phoneCallHandler: ToolHandler = async (args) => {
  try {
    const { prepareOutboundCall, confirmOutboundCall } = await import("../../phone/outbound");
    if (args.action === "prepare") {
      if (!args.query) return { result: "Missing person name or ID", error: true };
      const pending = await prepareOutboundCall(String(args.query));
      return { result: JSON.stringify({ kind: "phone_call_confirmation", status: "awaiting_confirmation", confirmationToken: pending.token, personId: pending.personId, personName: pending.personName, phoneNumber: pending.phoneNumber, expiresAt: new Date(pending.expiresAt).toISOString() }) };
    }
    if (args.action === "confirm") {
      if (!args.confirmationToken) return { result: "Missing confirmation token", error: true };
      const call = await confirmOutboundCall(String(args.confirmationToken));
      return { result: JSON.stringify({ kind: "phone_call_status", status: call.status, callSid: call.callSid, sessionId: call.sessionId }) };
    }
    return { result: "Unknown phone_call action. Available: prepare, confirm", error: true };
  } catch (error) {
    return { result: `Phone call error: ${error instanceof Error ? error.message : String(error)}`, error: true };
  }
};
