import type { ToolHandler } from "../contracts";

export const smsHandler: ToolHandler = async (args) => {
  try {
    const { prepareOutboundSms, confirmOutboundSms } = await import("../../sms-service");
    if (args.action === "prepare") {
      if (!args.query || !args.body) return { result: "Person and message body are required", error: true };
      const confirmation = await prepareOutboundSms(String(args.query), String(args.body));
      return { result: JSON.stringify({ kind: "sms_confirmation", status: "awaiting_confirmation", confirmationToken: confirmation.token, personId: confirmation.personId, personName: confirmation.personName, phoneNumber: confirmation.phoneNumber, body: confirmation.body, expiresAt: new Date(confirmation.expiresAt).toISOString() }) };
    }
    if (args.action === "confirm") {
      if (!args.confirmationToken) return { result: "Confirmation token is required", error: true };
      const sent = await confirmOutboundSms(String(args.confirmationToken));
      return { result: JSON.stringify({ kind: "sms_status", ...sent }) };
    }
    return { result: "Unknown sms action. Available: prepare, confirm", error: true };
  } catch (error) {
    return { result: `SMS error: ${error instanceof Error ? error.message : String(error)}`, error: true };
  }
};
