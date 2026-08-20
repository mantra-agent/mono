import type { ToolHandlerResult } from "../../tools/contracts";
import {
  inputFailure,
  internalFailure,
  permissionFailure,
  transientFailure,
} from "../../tool-failure";
import { contractReject } from "../../tools/shared/failures";
import {
  getMondayBoard,
  getMondayConnectionStatus,
  getMondayItem,
  listMondayBoards,
  listMondayColumns,
  listMondayItems,
  MondayApiError,
} from "./client";

function ok(result: unknown): ToolHandlerResult {
  return { result: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return fallback;
}

/**
 * Agent monday tool — read + status only. No GraphQL passthrough. No writes.
 */
export async function mondayToolHandler(args: Record<string, unknown>): Promise<ToolHandlerResult> {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (!action) {
    return contractReject("Missing 'action' parameter", "system_input_invalid", "monday_missing_action");
  }

  try {
    switch (action) {
      case "status": {
        const status = await getMondayConnectionStatus();
        return ok(status);
      }
      case "list_boards": {
        return ok(await listMondayBoards(asPositiveInt(args.limit, 50)));
      }
      case "get_board": {
        const boardId = typeof args.boardId === "string" ? args.boardId : "";
        return ok(await getMondayBoard(boardId));
      }
      case "list_columns": {
        const boardId = typeof args.boardId === "string" ? args.boardId : "";
        return ok(await listMondayColumns(boardId));
      }
      case "list_items": {
        const boardId = typeof args.boardId === "string" ? args.boardId : "";
        const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
        return ok(
          await listMondayItems({
            boardId,
            limit: asPositiveInt(args.limit, 50),
            cursor,
          }),
        );
      }
      case "get_item": {
        const itemId = typeof args.itemId === "string" ? args.itemId : "";
        return ok(await getMondayItem(itemId));
      }
      default:
        return contractReject(
          `Unknown monday action: ${action}. Allowed: status, list_boards, get_board, list_columns, list_items, get_item.`,
          "system_input_invalid",
          "monday_unknown_action",
        );
    }
  } catch (error) {
    if (error instanceof MondayApiError) {
      if (error.code === "monday_not_configured" || error.code === "monday_not_connected") {
        return {
          result: error.message,
          error: true,
          failure: inputFailure("integration_not_configured", error.code),
        };
      }
      if (
        error.code === "monday_missing_board_id" ||
        error.code === "monday_missing_item_id" ||
        error.code === "monday_board_not_found" ||
        error.code === "monday_item_not_found" ||
        error.status === 400 ||
        error.status === 404
      ) {
        return {
          result: error.message,
          error: true,
          failure: inputFailure("system_input_invalid", error.code || "monday_input"),
        };
      }
      if (error.code === "monday_unhealthy" || error.status === 403) {
        return {
          result: error.message,
          error: true,
          failure: permissionFailure("integration_auth_failed", error.code || "monday_auth"),
        };
      }
      return {
        result: error.message,
        error: true,
        // Provider HTTP/GraphQL blips — model may retry once; same code family as files transport.
        failure: transientFailure("files_provider_transient", error.code || "monday_http"),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: `Monday ${action} failed: ${message}`,
      error: true,
      failure: internalFailure("system_input_invalid", "monday_internal_error"),
    };
  }
}
