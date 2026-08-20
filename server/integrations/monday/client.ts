import { createLogger } from "../../log";
import { providerFetch, readBoundedProviderBody } from "../provider-http";
import {
  getMondayAccessTokenForAccount,
  mondayOAuthConfigured,
} from "./oauth";
import { listVisibleConnectedAccounts } from "../../connected-accounts";

const log = createLogger("MondayClient");

const GRAPHQL_URL = "https://api.monday.com/v2";
const API_VERSION = "2026-07";
const DEFAULT_ITEMS_LIMIT = 50;
const MAX_ITEMS_LIMIT = 500;
const MAX_BOARDS_LIMIT = 100;

export type MondayConnectionStatus =
  | { status: "not_configured"; message: string }
  | { status: "not_connected"; message: string }
  | {
      status: "connected";
      accountId: string;
      label: string | null;
      email: string | null;
      workspaceName: string | null;
      healthy: boolean;
      healthError: string | null;
    }
  | {
      status: "unhealthy";
      accountId: string;
      label: string | null;
      email: string | null;
      workspaceName: string | null;
      healthy: false;
      healthError: string | null;
    };

export class MondayApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "MondayApiError";
    this.status = status;
    if (code) this.code = code;
  }
}

export async function getMondayConnectionStatus(): Promise<MondayConnectionStatus> {
  if (!mondayOAuthConfigured()) {
    return {
      status: "not_configured",
      message: "Monday OAuth app secrets are not configured (MONDAY_CLIENT_ID / MONDAY_CLIENT_SECRET).",
    };
  }
  const accounts = await listVisibleConnectedAccounts("monday");
  const account = accounts[0];
  if (!account) {
    return {
      status: "not_connected",
      message: "No Monday account connected in a visible Vault.",
    };
  }
  if (account.healthy === false) {
    return {
      status: "unhealthy",
      accountId: account.accountId,
      label: account.label,
      email: account.email,
      workspaceName: account.workspaceName,
      healthy: false,
      healthError: account.healthError,
    };
  }
  return {
    status: "connected",
    accountId: account.accountId,
    label: account.label,
    email: account.email,
    workspaceName: account.workspaceName,
    healthy: account.healthy !== false,
    healthError: account.healthError,
  };
}

async function requireMondayAccountId(): Promise<string> {
  const status = await getMondayConnectionStatus();
  if (status.status === "not_configured") {
    throw new MondayApiError(status.message, 503, "monday_not_configured");
  }
  if (status.status === "not_connected") {
    throw new MondayApiError(status.message, 403, "monday_not_connected");
  }
  if (status.status === "unhealthy") {
    throw new MondayApiError(
      status.healthError || "Monday connection unhealthy; reconnect required",
      403,
      "monday_unhealthy",
    );
  }
  return status.accountId;
}

async function mondayGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const accountId = await requireMondayAccountId();
  const accessToken = await getMondayAccessTokenForAccount(accountId);
  const response = await providerFetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: accessToken,
      "content-type": "application/json",
      "API-Version": API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 20_000,
  });
  if (!response.ok) {
    const detail = await readBoundedProviderBody(response);
    log.warn("Monday GraphQL HTTP failure", {
      status: response.status,
      detailLength: detail.length,
    });
    throw new MondayApiError(
      `Monday API request failed (${response.status})`,
      response.status === 401 || response.status === 403 ? 403 : 502,
      "monday_http_error",
    );
  }
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).filter(Boolean).join("; ") || "Monday GraphQL error";
    throw new MondayApiError(message.slice(0, 400), 502, "monday_graphql_error");
  }
  if (!body.data) {
    throw new MondayApiError("Monday GraphQL returned no data", 502, "monday_empty_data");
  }
  return body.data;
}

export async function listMondayBoards(limit = 50) {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), MAX_BOARDS_LIMIT);
  const data = await mondayGraphql<{
    boards: Array<{
      id: string;
      name: string;
      description?: string | null;
      state?: string | null;
      board_kind?: string | null;
      workspace_id?: string | null;
      updated_at?: string | null;
    }>;
  }>(
    `query ($limit: Int!) {
      boards(limit: $limit, order_by: created_at) {
        id
        name
        description
        state
        board_kind
        workspace_id
        updated_at
      }
    }`,
    { limit: safeLimit },
  );
  return {
    boards: (data.boards || []).map((board) => ({
      id: String(board.id),
      name: board.name,
      description: board.description ?? null,
      state: board.state ?? null,
      boardKind: board.board_kind ?? null,
      workspaceId: board.workspace_id != null ? String(board.workspace_id) : null,
      updatedAt: board.updated_at ?? null,
    })),
  };
}

export async function getMondayBoard(boardId: string) {
  const id = String(boardId || "").trim();
  if (!id) throw new MondayApiError("boardId is required", 400, "monday_missing_board_id");
  const data = await mondayGraphql<{
    boards: Array<{
      id: string;
      name: string;
      description?: string | null;
      state?: string | null;
      board_kind?: string | null;
      workspace_id?: string | null;
      groups?: Array<{ id: string; title: string; position?: string | null }>;
      columns?: Array<{ id: string; title: string; type: string; settings_str?: string | null }>;
    }>;
  }>(
    `query ($ids: [ID!]!) {
      boards(ids: $ids) {
        id
        name
        description
        state
        board_kind
        workspace_id
        groups { id title position }
        columns { id title type settings_str }
      }
    }`,
    { ids: [id] },
  );
  const board = data.boards?.[0];
  if (!board) throw new MondayApiError(`Board ${id} not found or not visible`, 404, "monday_board_not_found");
  return {
    id: String(board.id),
    name: board.name,
    description: board.description ?? null,
    state: board.state ?? null,
    boardKind: board.board_kind ?? null,
    workspaceId: board.workspace_id != null ? String(board.workspace_id) : null,
    groups: (board.groups || []).map((g, index) => ({
      id: String(g.id),
      title: g.title,
      position: g.position ?? String(index),
    })),
    columns: (board.columns || []).map((c) => ({
      id: String(c.id),
      title: c.title,
      type: c.type,
      settings: c.settings_str ?? null,
    })),
  };
}

export async function listMondayColumns(boardId: string) {
  const board = await getMondayBoard(boardId);
  return { boardId: board.id, columns: board.columns };
}

export async function listMondayItems(input: {
  boardId: string;
  limit?: number;
  cursor?: string;
}) {
  const boardId = String(input.boardId || "").trim();
  if (!boardId) throw new MondayApiError("boardId is required", 400, "monday_missing_board_id");
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit || DEFAULT_ITEMS_LIMIT) || DEFAULT_ITEMS_LIMIT),
    MAX_ITEMS_LIMIT,
  );
  const cursor = typeof input.cursor === "string" && input.cursor.trim() ? input.cursor.trim() : null;

  const data = await mondayGraphql<{
    boards: Array<{
      id: string;
      items_page: {
        cursor?: string | null;
        items: Array<{
          id: string;
          name: string;
          group?: { id: string; title?: string } | null;
          column_values?: Array<{ id: string; type?: string; text?: string | null; value?: string | null }>;
        }>;
      };
    }>;
  }>(
    cursor
      ? `query ($ids: [ID!]!, $limit: Int!, $cursor: String!) {
          boards(ids: $ids) {
            id
            items_page(limit: $limit, cursor: $cursor) {
              cursor
              items {
                id
                name
                group { id title }
                column_values { id type text value }
              }
            }
          }
        }`
      : `query ($ids: [ID!]!, $limit: Int!) {
          boards(ids: $ids) {
            id
            items_page(limit: $limit) {
              cursor
              items {
                id
                name
                group { id title }
                column_values { id type text value }
              }
            }
          }
        }`,
    cursor ? { ids: [boardId], limit, cursor } : { ids: [boardId], limit },
  );
  const board = data.boards?.[0];
  if (!board) throw new MondayApiError(`Board ${boardId} not found or not visible`, 404, "monday_board_not_found");
  const page = board.items_page;
  return {
    boardId: String(board.id),
    cursor: page?.cursor ?? null,
    items: (page?.items || []).map((item) => ({
      id: String(item.id),
      name: item.name,
      groupId: item.group?.id != null ? String(item.group.id) : null,
      groupTitle: item.group?.title ?? null,
      columnValues: (item.column_values || []).map((cv) => ({
        id: String(cv.id),
        type: cv.type ?? null,
        text: cv.text ?? null,
        // value can be large JSON; keep bounded for agent eyes
        value: typeof cv.value === "string" && cv.value.length > 2000
          ? `${cv.value.slice(0, 2000)}…`
          : cv.value ?? null,
      })),
    })),
  };
}

export async function getMondayItem(itemId: string) {
  const id = String(itemId || "").trim();
  if (!id) throw new MondayApiError("itemId is required", 400, "monday_missing_item_id");
  const data = await mondayGraphql<{
    items: Array<{
      id: string;
      name: string;
      board?: { id: string; name?: string } | null;
      group?: { id: string; title?: string } | null;
      column_values?: Array<{ id: string; type?: string; text?: string | null; value?: string | null }>;
    }>;
  }>(
    `query ($ids: [ID!]!) {
      items(ids: $ids) {
        id
        name
        board { id name }
        group { id title }
        column_values { id type text value }
      }
    }`,
    { ids: [id] },
  );
  const item = data.items?.[0];
  if (!item) throw new MondayApiError(`Item ${id} not found or not visible`, 404, "monday_item_not_found");
  return {
    id: String(item.id),
    name: item.name,
    boardId: item.board?.id != null ? String(item.board.id) : null,
    boardName: item.board?.name ?? null,
    groupId: item.group?.id != null ? String(item.group.id) : null,
    groupTitle: item.group?.title ?? null,
    columnValues: (item.column_values || []).map((cv) => ({
      id: String(cv.id),
      type: cv.type ?? null,
      text: cv.text ?? null,
      value: typeof cv.value === "string" && cv.value.length > 2000
        ? `${cv.value.slice(0, 2000)}…`
        : cv.value ?? null,
    })),
  };
}
