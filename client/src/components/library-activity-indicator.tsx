import { useQuery } from "@tanstack/react-query";


type TreeNodeLike = { id: string; children: TreeNodeLike[] };

export function computeHasUnreadDescendantIds(
  nodes: TreeNodeLike[],
  unreadIds: Set<string>,
): Set<string> {
  const result = new Set<string>();
  function walk(node: TreeNodeLike): boolean {
    let hasUnread = false;
    for (const child of node.children) {
      if (unreadIds.has(child.id)) hasUnread = true;
      if (walk(child)) hasUnread = true;
    }
    if (hasUnread) result.add(node.id);
    return hasUnread;
  }
  for (const node of nodes) walk(node);
  return result;
}

export function useLibraryUnread() {
  return useQuery<string[]>({
    queryKey: ["/api/info/library/unread"],
    refetchInterval: 30000,
  });
}

export function useLibraryActivity(): boolean {
  const { data: unreadIds } = useLibraryUnread();
  return (unreadIds?.length ?? 0) > 0;
}

