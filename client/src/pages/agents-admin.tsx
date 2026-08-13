import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, ChevronRight, Loader2, MoreHorizontal, ShieldBan, ShieldCheck } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import {
  IDENTITY_GRAPH_QUERY_KEY,
  matchesIdentityQuery,
  useIdentityGraph,
  type IdentityGraphAccount,
  type IdentityGraphInstance,
  type IdentityGraphUser,
} from "@/lib/identity-graph";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createReferenceRef } from "@shared/references";

function AgentRow({
  instance,
  account,
  users,
  defaultOpen,
  canWrite,
}: {
  instance: IdentityGraphInstance;
  account: IdentityGraphAccount | null;
  users: IdentityGraphUser[];
  defaultOpen: boolean;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { toast } = useToast();
  const isQuarantined = instance.status === "quarantined";
  const children = useMemo(() => {
    const refs = [];
    if (account) {
      refs.push(createReferenceRef({
        type: "account",
        id: account.id,
        metadata: { label: account.name },
      }));
    }
    for (const user of users) {
      refs.push(createReferenceRef({
        type: "user",
        id: user.id,
        metadata: { label: user.email },
      }));
    }
    return refs;
  }, [account, users]);

  const quarantineMutation = useMutation({
    mutationFn: async (action: "quarantine" | "restore") =>
      (await apiRequest("POST", `/api/auth/instances/${instance.id}/quarantine`, {
        action,
        reason: action === "quarantine" ? "manual_instance_quarantine" : undefined,
      })).json(),
    onSuccess: async (_data, action) => {
      await queryClient.invalidateQueries({ queryKey: IDENTITY_GRAPH_QUERY_KEY });
      toast({
        title: action === "quarantine" ? "Agent quarantined" : "Agent restored",
        description: instance.name,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update agent", description: error.message, variant: "destructive" });
    },
  });

  return (
    <div className="min-w-0" data-testid={`agent-row-${instance.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/70">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{instance.name}</span>
          <span className={cn("shrink-0 text-xs capitalize", isQuarantined ? "text-destructive" : "text-muted-foreground")}>
            {instance.status}
          </span>
        </button>
        {canWrite ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={`More actions for ${instance.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                {quarantineMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isQuarantined ? (
                <DropdownMenuItem
                  disabled={quarantineMutation.isPending}
                  onSelect={() => quarantineMutation.mutate("restore")}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={quarantineMutation.isPending}
                  onSelect={() => quarantineMutation.mutate("quarantine")}
                >
                  <ShieldBan className="mr-2 h-4 w-4" />
                  Quarantine
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {open ? (
        children.length === 0 ? (
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No account or members.</div>
          </HierarchyTreeRow>
        ) : (
          children.map((ref, index) => (
            <HierarchyTreeRow
              key={ref.canonical}
              continues={index < children.length - 1}
              indent="icon"
              connectorAnchor="first-row-center"
            >
              <div className="flex min-h-8 items-center px-1 py-0.5">
                <ReferenceRenderer refValue={ref} surface="simple-row" className="max-w-full" />
              </div>
            </HierarchyTreeRow>
          ))
        )
      ) : null}
    </div>
  );
}

export default function AgentsAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("users:read");
  const canWrite = hasPermission("users:write");
  const { data, isLoading } = useIdentityGraph(canRead);
  const [search, setSearch] = useState("");
  usePageHeader({ title: "Agents" });
  usePageLoadActivity("page:agents", isLoading);

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((account) => [account.id, account])),
    [data?.accounts],
  );
  const usersById = useMemo(() => new Map((data?.users ?? []).map((user) => [user.id, user])), [data?.users]);
  const membersByInstance = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const membership of data?.instanceMemberships ?? []) {
      const list = map.get(membership.instanceId) ?? [];
      list.push(membership.userId);
      map.set(membership.instanceId, list);
    }
    return map;
  }, [data?.instanceMemberships]);

  const instances = useMemo(() => {
    const rows = data?.instances ?? [];
    return rows.filter((instance) => {
      const account = accountsById.get(instance.accountId) ?? null;
      const members = (membersByInstance.get(instance.id) ?? [])
        .map((userId) => usersById.get(userId))
        .filter((user): user is IdentityGraphUser => Boolean(user));
      return matchesIdentityQuery(
        search,
        instance.name,
        instance.status,
        instance.id,
        account?.name,
        account?.kind,
        ...members.map((user) => user.email),
      );
    });
  }, [accountsById, data?.instances, membersByInstance, search, usersById]);

  if (!canRead) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Agents administration requires users:read.</div>;
  }
  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="agents-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-agents"
            clearTestId="button-clear-agent-search"
            ariaLabel="Search agents"
          />
          <Collapsible defaultOpen>
            <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
              <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
              Agents <span className="font-normal">({instances.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {instances.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No agents.</div>
              ) : (
                instances.map((instance) => {
                  const account = accountsById.get(instance.accountId) ?? null;
                  const members = (membersByInstance.get(instance.id) ?? [])
                    .map((userId) => usersById.get(userId))
                    .filter((user): user is IdentityGraphUser => Boolean(user))
                    .sort((a, b) => a.email.localeCompare(b.email));
                  return (
                    <AgentRow
                      key={instance.id}
                      instance={instance}
                      account={account}
                      users={members}
                      defaultOpen={Boolean(search.trim())}
                      canWrite={canWrite}
                    />
                  );
                })
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
