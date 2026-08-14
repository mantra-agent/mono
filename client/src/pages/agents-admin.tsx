import { useMemo, useState } from "react";
import { Bot, Brain, ChevronRight, Clock, Loader2, Timer } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import {
  agentSection,
  matchesIdentityQuery,
  useIdentityGraph,
  type AgentLifecycleStatus,
  type IdentityGraphAccount,
  type IdentityGraphInstance,
  type IdentityGraphUser,
} from "@/lib/identity-graph";
import { cn } from "@/lib/utils";
import { createReferenceRef } from "@shared/references";

const AGENT_SECTIONS: Array<{ id: AgentLifecycleStatus; label: string; defaultOpen: boolean }> = [
  { id: "active", label: "ACTIVE", defaultOpen: true },
  { id: "paused", label: "PAUSED", defaultOpen: true },
  { id: "archived", label: "ARCHIVED", defaultOpen: false },
];

function AgentRow({
  instance,
  account,
  users,
  defaultOpen,
}: {
  instance: IdentityGraphInstance;
  account: IdentityGraphAccount | null;
  users: IdentityGraphUser[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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

  return (
    <div className="min-w-0" data-testid={`agent-row-${instance.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/70">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{instance.name}</span>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
        </span>
      </div>
      {open ? (
        <>
          {children.length === 0 ? (
            <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No account or members.</div>
            </HierarchyTreeRow>
          ) : (
            children.map((ref) => (
              <HierarchyTreeRow
                key={ref.canonical}
                continues
                indent="icon"
                connectorAnchor="first-row-center"
              >
                <div className="flex min-h-8 items-center px-1 py-0.5">
                  <ReferenceRenderer refValue={ref} surface="simple-row" className="max-w-full" />
                </div>
              </HierarchyTreeRow>
            ))
          )}
          <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow label="Timers" icon={<Timer className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-foreground">{(instance.managedTimerCount ?? 0).toLocaleString()}</span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
          <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow label="User Memory" icon={<Brain className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-foreground">{(instance.claimCount ?? 0).toLocaleString()}</span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow label="Tokens Used" icon={<Clock className="h-3.5 w-3.5" />} hasValue showEmpty>
              <span className="text-foreground">{(instance.inputTokens7d ?? 0).toLocaleString()}</span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
        </>
      ) : null}
    </div>
  );
}

export default function AgentsAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("users:read");
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
      if (instance.status === "quarantined") return false;
      const account = accountsById.get(instance.accountId) ?? null;
      const members = (membersByInstance.get(instance.id) ?? [])
        .map((userId) => usersById.get(userId))
        .filter((user): user is IdentityGraphUser => Boolean(user));
      return matchesIdentityQuery(
        search,
        instance.name,
        instance.id,
        account?.name,
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
          {AGENT_SECTIONS.map((section) => {
            const rows = instances.filter((instance) => agentSection(instance.status) === section.id);
            return (
              <Collapsible key={section.id} defaultOpen={section.defaultOpen}>
                <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
                  <ChevronRight className="h-3 w-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90" />
                  {section.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {rows.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No agents.</div>
                  ) : (
                    rows.map((instance) => {
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
                        />
                      );
                    })
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </div>
    </div>
  );
}
