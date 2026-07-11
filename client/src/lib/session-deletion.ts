import type { ChatSession } from "@shared/models/chat";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface SessionDeletionResult {
  deletedSessionIds: string[];
  descendantCount: number;
}

export function getSessionDescendantIds(
  sessions: ChatSession[] | undefined,
  rootSessionId: string | null | undefined,
): string[] {
  if (!sessions || !rootSessionId) return [];

  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = childrenByParent.get(session.parentSessionId) ?? [];
    children.push(session.id);
    childrenByParent.set(session.parentSessionId, children);
  }

  const descendants: string[] = [];
  const pending = [...(childrenByParent.get(rootSessionId) ?? [])];
  const visited = new Set<string>([rootSessionId]);
  while (pending.length > 0) {
    const sessionId = pending.shift()!;
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);
    descendants.push(sessionId);
    pending.push(...(childrenByParent.get(sessionId) ?? []));
  }
  return descendants;
}

export function getSessionDeletionDescription(
  sessions: ChatSession[] | undefined,
  rootSessionId: string | null | undefined,
  options?: { inlineWidget?: boolean },
): string {
  const descendantCount = getSessionDescendantIds(sessions, rootSessionId).length;
  const widgetPrefix = options?.inlineWidget ? "This inline session widget will disappear. " : "";
  if (descendantCount === 0) {
    return `${widgetPrefix}Permanently delete this session and all its messages?`;
  }
  const label = descendantCount === 1 ? "descendant session" : "descendant sessions";
  return `${widgetPrefix}Permanently delete this session, its ${descendantCount} ${label}, and all their messages?`;
}

export async function deleteSessionTree(
  sessionId: string,
  path = `/api/sessions/${encodeURIComponent(sessionId)}`,
): Promise<SessionDeletionResult> {
  const response = await apiRequest("DELETE", path);
  const result = (await response.json()) as SessionDeletionResult;

  const deletedIds = new Set(result.deletedSessionIds);
  queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) =>
    old?.filter((session) => !deletedIds.has(session.id)),
  );
  for (const deletedSessionId of result.deletedSessionIds) {
    queryClient.removeQueries({ queryKey: ["/api/sessions", deletedSessionId] });
  }
  return result;
}
