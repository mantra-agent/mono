import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, Clock, Gauge, Gift, Loader2, MoreHorizontal, Pause, Route } from "lucide-react";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { EditableSessionTitle } from "@/components/editable-session-title";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { formatDateTime as formatDateTimeInTimezone, useTimezone } from "@/hooks/use-timezone";
import { useToast } from "@/hooks/use-toast";
import {
  accountDeleteConfirmation,
  accountSection,
  accountTreeSection,
  IDENTITY_GRAPH_QUERY_KEY,
  matchesIdentityQuery,
  useIdentityGraph,
  type AccountLifecycleStatus,
  type AccountTreeSection,
  type IdentityGraphAccount,
  type IdentityGraphInstance,
  type IdentityGraphUser,
} from "@/lib/identity-graph";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createReferenceRef } from "@shared/references";

const ACCOUNT_SECTIONS: Array<{ id: AccountTreeSection; label: string; defaultOpen: boolean; lazy: boolean }> = [
  { id: "registered", label: "REGISTERED", defaultOpen: true, lazy: false },
  { id: "activated", label: "ACTIVATED", defaultOpen: true, lazy: false },
  { id: "suspended", label: "SUSPENDED", defaultOpen: true, lazy: false },
  { id: "archived", label: "ARCHIVED", defaultOpen: false, lazy: true },
];

function ownerEmail(account: IdentityGraphAccount, users: IdentityGraphUser[]): string {
  return users.find((user) => user.id === account.ownerUserId)?.email
    ?? users[0]?.email
    ?? "unknown";
}

function formatTokenCount(value: number | null | undefined): string {
  if (value == null) return "None";
  return value.toLocaleString("en-US");
}

function accountChip(account: Pick<IdentityGraphAccount, "id" | "name">): string {
  return createReferenceRef({
    type: "account",
    id: account.id,
    metadata: { label: account.name },
  }).canonical;
}

function AccountRow({
  account,
  users,
  instances,
  defaultOpen,
  canWrite,
  timezone,
  onRename,
  onStatus,
  onDelete,
  onAssignRouter,
  onSetInclude,
  onGrantUsage,
}: {
  account: IdentityGraphAccount;
  users: IdentityGraphUser[];
  instances: IdentityGraphInstance[];
  defaultOpen: boolean;
  canWrite: boolean;
  timezone: string;
  onRename: (account: IdentityGraphAccount, name: string) => void;
  onStatus: (account: IdentityGraphAccount, status: AccountLifecycleStatus) => void;
  onDelete: (account: IdentityGraphAccount, email: string) => void;
  onAssignRouter: (account: IdentityGraphAccount, routerId: string) => void;
  onSetInclude: (account: IdentityGraphAccount, includedTokens: number | null) => void;
  onGrantUsage: (account: IdentityGraphAccount, tokens: number) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [modsOpen, setModsOpen] = useState(false);
  const [includeDraft, setIncludeDraft] = useState(
    account.includedTokens == null ? "" : String(account.includedTokens),
  );
  const [grantDraft, setGrantDraft] = useState("");
  const paying = account.includedTokens != null;
  const { toast } = useToast();
  const modsQuery = useQuery<{ mods: Array<{ key: string; name: string; status: string }>; canManage: boolean }>({
    queryKey: ["/api/admin/accounts", account.id, "mods"],
    queryFn: async () => (await apiRequest("GET", `/api/admin/accounts/${account.id}/mods`)).json(),
    enabled: modsOpen,
  });
  const modMutation = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) =>
      (await apiRequest("POST", `/api/admin/accounts/${account.id}/mods/${key}/${enabled ? "install" : "disable"}`)).json(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/accounts", account.id, "mods"] });
      await queryClient.invalidateQueries({ queryKey: IDENTITY_GRAPH_QUERY_KEY });
    },
    onError: (error: Error) => toast({ title: "Could not update Mod", description: error.message, variant: "destructive" }),
  });
  const email = ownerEmail(account, users);
  const children = useMemo(() => {
    const userRefs = users.map((user) => createReferenceRef({
      type: "user",
      id: user.id,
      metadata: { label: user.email },
    }));
    const instanceRefs = instances.map((instance) => createReferenceRef({
      type: "agent_instance",
      id: instance.id,
      metadata: { label: instance.name },
    }));
    return [...userRefs, ...instanceRefs];
  }, [users, instances]);
  const lastActive = account.lastActiveAt
    ? formatDateTimeInTimezone(account.lastActiveAt, timezone, { year: "numeric" })
    : "No activity yet";

  return (
    <div className="min-w-0" data-testid={`account-row-${account.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/70">
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <EditableSessionTitle
          title={account.name}
          canEdit={canWrite}
          onCommit={(name) => onRename(account, name)}
          className="min-w-0 flex-1 truncate font-normal text-foreground"
        />
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
        {canWrite ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Actions for ${account.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {accountSection(account.status) !== "suspended" ? (
                <DropdownMenuItem onClick={() => onStatus(account, "suspended")}>Suspend</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onStatus(account, "active")}>Activate</DropdownMenuItem>
              )}
              {accountSection(account.status) !== "archived" ? (
                <DropdownMenuItem onClick={() => onStatus(account, "archived")}>Archive</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onStatus(account, "active")}>Restore</DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete(account, email)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {open ? (
        <>
          {children.length === 0 ? (
            <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No members or agents.</div>
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
            <div className="group/router flex w-full min-w-0 items-stretch">
              <div className="min-w-0 flex-1">
                <ProfileTreeRow
                  label="Router"
                  icon={<Route className="h-3.5 w-3.5" />}
                  hasValue={Boolean(account.router)}
                  showEmpty
                >
                  {account.router ? (
                    <ReferenceRenderer
                      refValue={createReferenceRef({
                        type: "router",
                        id: account.router.id,
                        metadata: { label: account.router.name },
                      })}
                      surface="simple-row"
                      className="max-w-full"
                    />
                  ) : (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                </ProfileTreeRow>
              </div>
              {canWrite ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="mt-1 mr-1 flex h-7 w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover/router:opacity-100 data-[state=open]:opacity-100"
                      aria-label="Change router"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72 p-2">
                    <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">Assign Router</p>
                    <ReferencePicker
                      value={
                        account.router
                          ? [{ type: "router", id: account.router.id, label: account.router.name } satisfies ReferencePickerValue]
                          : []
                      }
                      onChange={(next) => {
                        const selected = next[0];
                        if (selected) onAssignRouter(account, selected.id);
                      }}
                      types={["router"]}
                      mode="single"
                      variant="compact"
                      placeholder="Choose router"
                      showToken={false}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </HierarchyTreeRow>
          <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
            <div className="min-w-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/70"
                onClick={() => setModsOpen((value) => !value)}
                aria-expanded={modsOpen}
                data-testid={`account-mods-toggle-${account.id}`}
              >
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", modsOpen && "rotate-90")} />
                <span className="text-xs font-bold uppercase tracking-wider">Mods</span>
              </button>
              {modsOpen ? (
                <div className="mt-0 space-y-0">
                  {modsQuery.isLoading ? (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading Mods…
                    </div>
                  ) : modsQuery.isError ? (
                    <div className="px-2 py-1.5 text-sm text-destructive">Could not load Mods.</div>
                  ) : (modsQuery.data?.mods ?? []).length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No Mods.</div>
                  ) : (
                    (modsQuery.data?.mods ?? []).map((mod) => {
                      const enabled = mod.status === "enabled";
                      const pending = modMutation.isPending && modMutation.variables?.key === mod.key;
                      return (
                        <div key={mod.key} className="flex items-center gap-2 px-2 py-1.5 text-sm" data-testid={`account-mod-row-${account.id}-${mod.key}`}>
                          <SimpleCheckCircle
                            checked={enabled}
                            pending={pending}
                            disabled={!canWrite || !(modsQuery.data?.canManage ?? false) || pending}
                            label={enabled ? `Disable ${mod.name}` : `Enable ${mod.name}`}
                            onClick={() => modMutation.mutate({ key: mod.key, enabled: !enabled })}
                          />
                          <span className={enabled ? "text-foreground" : "text-muted-foreground"}>{mod.name}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          </HierarchyTreeRow>
          <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow
              label="Include"
              icon={<Gauge className="h-3.5 w-3.5" />}
              hasValue={account.includedTokens != null}
              showEmpty
              menuContent={canWrite ? (
                <div className="space-y-2 p-1">
                  <Input
                    type="number"
                    min={0}
                    value={includeDraft}
                    onChange={(event) => setIncludeDraft(event.target.value)}
                    aria-label="Included tokens"
                    className="h-8"
                  />
                  <DropdownMenuItem
                    onClick={() => {
                      const parsed = includeDraft.trim() === "" ? null : Number(includeDraft);
                      if (parsed != null && (!Number.isInteger(parsed) || parsed < 0)) return;
                      onSetInclude(account, parsed);
                    }}
                  >
                    Save include
                  </DropdownMenuItem>
                  {account.includedTokens != null ? (
                    <DropdownMenuItem onClick={() => onSetInclude(account, null)}>
                      Clear include
                    </DropdownMenuItem>
                  ) : null}
                </div>
              ) : undefined}
            >
              <span className={account.includedTokens != null ? "text-foreground" : "text-muted-foreground"}>
                {formatTokenCount(account.includedTokens)}
              </span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
          {paying ? (
            <>
              <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
                <ProfileTreeRow label="Period" icon={<Clock className="h-3.5 w-3.5" />} hasValue={Boolean(account.usagePeriod)} showEmpty>
                  <span className="text-foreground">{account.usagePeriod ?? "—"} · {formatTokenCount(account.periodTokens ?? 0)}</span>
                </ProfileTreeRow>
              </HierarchyTreeRow>
              <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
                <ProfileTreeRow
                  label="Status"
                  icon={<Pause className="h-3.5 w-3.5" />}
                  hasValue={Boolean(account.usageStatus)}
                  showEmpty
                >
                  <span className="text-foreground">{account.usageStatus ?? "ok"}</span>
                </ProfileTreeRow>
              </HierarchyTreeRow>
              <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
                <ProfileTreeRow
                  label="Granted"
                  icon={<Gift className="h-3.5 w-3.5" />}
                  hasValue={(account.grantedTokens ?? 0) > 0}
                  showEmpty
                  menuContent={canWrite ? (
                    <div className="space-y-2 p-1">
                      <Input
                        type="number"
                        min={1}
                        value={grantDraft}
                        onChange={(event) => setGrantDraft(event.target.value)}
                        aria-label="Grant tokens"
                        className="h-8"
                      />
                      <DropdownMenuItem
                        onClick={() => {
                          const parsed = Number(grantDraft);
                          if (!Number.isInteger(parsed) || parsed <= 0) return;
                          onGrantUsage(account, parsed);
                          setGrantDraft("");
                        }}
                      >
                        Grant
                      </DropdownMenuItem>
                    </div>
                  ) : undefined}
                >
                  <span className={(account.grantedTokens ?? 0) > 0 ? "text-foreground" : "text-muted-foreground"}>
                    {formatTokenCount(account.grantedTokens ?? 0)}
                  </span>
                </ProfileTreeRow>
              </HierarchyTreeRow>
              <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
                <ProfileTreeRow label="Emitted" icon={<Gauge className="h-3.5 w-3.5" />} hasValue={(account.emittedOverageTokens ?? 0) > 0} showEmpty>
                  <span className="text-foreground">{formatTokenCount(account.emittedOverageTokens ?? 0)}</span>
                </ProfileTreeRow>
              </HierarchyTreeRow>
            </>
          ) : null}
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <ProfileTreeRow label="Last Active" icon={<Clock className="h-3.5 w-3.5" />} hasValue={!!account.lastActiveAt} showEmpty>
              <span className={account.lastActiveAt ? "text-foreground" : "text-muted-foreground"}>{lastActive}</span>
            </ProfileTreeRow>
          </HierarchyTreeRow>
        </>
      ) : null}
    </div>
  );
}

export default function AccountsAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("users:read");
  const canWrite = hasPermission("users:write");
  const { data, isLoading } = useIdentityGraph(canRead);
  const [search, setSearch] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<{ account: IdentityGraphAccount; status: "suspended" | "archived" } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ account: IdentityGraphAccount; email: string } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const { timezone } = useTimezone();
  const { toast } = useToast();
  usePageHeader({ title: "Accounts" });
  usePageLoadActivity("page:accounts", isLoading);

  const usersById = useMemo(() => new Map((data?.users ?? []).map((user) => [user.id, user])), [data?.users]);
  const membershipsByAccount = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const membership of data?.memberships ?? []) {
      const list = map.get(membership.accountId) ?? [];
      list.push(membership.userId);
      map.set(membership.accountId, list);
    }
    return map;
  }, [data?.memberships]);
  const instancesByAccount = useMemo(() => {
    const map = new Map<string, IdentityGraphInstance[]>();
    for (const instance of data?.instances ?? []) {
      const list = map.get(instance.accountId) ?? [];
      list.push(instance);
      map.set(instance.accountId, list);
    }
    return map;
  }, [data?.instances]);

  const accounts = useMemo(() => {
    const rows = data?.accounts ?? [];
    return rows.filter((account) => {
      const memberUsers = (membershipsByAccount.get(account.id) ?? [])
        .map((userId) => usersById.get(userId))
        .filter((user): user is IdentityGraphUser => Boolean(user));
      const instances = instancesByAccount.get(account.id) ?? [];
      return matchesIdentityQuery(
        search,
        account.name,
        account.id,
        ...memberUsers.map((user) => user.email),
        ...instances.map((instance) => instance.name),
      );
    });
  }, [data?.accounts, instancesByAccount, membershipsByAccount, search, usersById]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: IDENTITY_GRAPH_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
  };

  const statusMutation = useMutation({
    mutationFn: async ({ account, status }: { account: IdentityGraphAccount; status: AccountLifecycleStatus }) => {
      await apiRequest("PATCH", `/api/auth/accounts/${account.id}/status`, { status });
      return { account, status };
    },
    onSuccess: async (result) => {
      await invalidate();
      setPendingStatus(null);
      const verb = result.status === "active"
        ? "restored"
        : result.status === "suspended"
          ? "suspended"
          : "archived";
      toast({ title: `${accountChip(result.account)} ${verb}` });
    },
    onError: (error: Error) => toast({ title: "Could not update account", description: error.message, variant: "destructive" }),
  });

  const routerMutation = useMutation({
    mutationFn: async ({ account, routerId }: { account: IdentityGraphAccount; routerId: string }) => {
      await apiRequest("PATCH", `/api/auth/accounts/${account.id}/router`, { routerId });
      return { account, routerId };
    },
    onSuccess: async () => {
      await invalidate();
      toast({ title: "Router assigned" });
    },
    onError: (error: Error) => toast({ title: "Could not assign router", description: error.message, variant: "destructive" }),
  });

  const includeMutation = useMutation({
    mutationFn: async ({ account, includedTokens }: { account: IdentityGraphAccount; includedTokens: number | null }) => {
      await apiRequest("PATCH", `/api/auth/accounts/${account.id}/include`, { includedTokens });
      return { account, includedTokens };
    },
    onSuccess: async () => {
      await invalidate();
      toast({ title: "Include updated" });
    },
    onError: (error: Error) => toast({ title: "Could not set include", description: error.message, variant: "destructive" }),
  });

  const grantMutation = useMutation({
    mutationFn: async ({ account, tokens }: { account: IdentityGraphAccount; tokens: number }) => {
      await apiRequest("POST", `/api/auth/accounts/${account.id}/usage-grant`, { tokens });
      return { account, tokens };
    },
    onSuccess: async () => {
      await invalidate();
      toast({ title: "Usage granted" });
    },
    onError: (error: Error) => toast({ title: "Could not grant usage", description: error.message, variant: "destructive" }),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ account, name }: { account: IdentityGraphAccount; name: string }) => {
      await apiRequest("PATCH", `/api/auth/accounts/${account.id}/name`, { name });
      return { account, name };
    },
    onSuccess: async (result) => {
      await invalidate();
      toast({ title: `Renamed ${accountChip({ id: result.account.id, name: result.name })}` });
    },
    onError: (error: Error) => toast({ title: "Could not rename account", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ account, confirmation: typed }: { account: IdentityGraphAccount; confirmation: string }) => {
      await apiRequest("DELETE", `/api/auth/accounts/${account.id}`, { confirmation: typed });
      return account;
    },
    onSuccess: async (account) => {
      await invalidate();
      setPendingDelete(null);
      setConfirmation("");
      toast({ title: `Deleted ${accountChip(account)}` });
    },
    onError: (error: Error) => toast({ title: "Could not delete account", description: error.message, variant: "destructive" }),
  });

  const requestStatus = (account: IdentityGraphAccount, status: AccountLifecycleStatus) => {
    if (status === "suspended" || status === "archived") {
      setPendingStatus({ account, status });
      return;
    }
    statusMutation.mutate({ account, status });
  };

  if (!canRead) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Accounts administration requires users:read.</div>;
  }
  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const expectedDelete = pendingDelete ? accountDeleteConfirmation(pendingDelete.email) : "";

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="accounts-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-accounts"
            clearTestId="button-clear-account-search"
            ariaLabel="Search accounts"
          />
          {ACCOUNT_SECTIONS.map((section) => {
            const rows = accounts.filter((account) => {
              const owner = usersById.get(account.ownerUserId ?? "");
              return accountTreeSection(account.status, owner?.onboardingStatus) === section.id;
            });
            const open = section.lazy ? archiveOpen : section.defaultOpen;
            return (
              <Collapsible
                key={section.id}
                open={section.lazy ? archiveOpen : undefined}
                defaultOpen={section.lazy ? undefined : section.defaultOpen}
                onOpenChange={section.lazy ? setArchiveOpen : undefined}
              >
                <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
                  <ChevronRight className="h-3 w-3 shrink-0 transition-transform [[data-state=open]_&]:rotate-90" />
                  {section.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {section.lazy && !archiveOpen ? null : rows.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No accounts.</div>
                  ) : (
                    rows.map((account) => {
                      const memberUsers = (membershipsByAccount.get(account.id) ?? [])
                        .map((userId) => usersById.get(userId))
                        .filter((user): user is IdentityGraphUser => Boolean(user))
                        .sort((a, b) => a.email.localeCompare(b.email));
                      const instances = [...(instancesByAccount.get(account.id) ?? [])]
                        .sort((a, b) => a.name.localeCompare(b.name));
                      return (
                        <AccountRow
                          key={account.id}
                          account={account}
                          users={memberUsers}
                          instances={instances}
                          defaultOpen={Boolean(search.trim())}
                          canWrite={canWrite}
                          timezone={timezone}
                          onRename={(next, name) => renameMutation.mutate({ account: next, name })}
                          onStatus={requestStatus}
                          onDelete={(next, email) => setPendingDelete({ account: next, email })}
                          onAssignRouter={(next, routerId) => routerMutation.mutate({ account: next, routerId })}
                          onSetInclude={(next, includedTokens) => includeMutation.mutate({ account: next, includedTokens })}
                          onGrantUsage={(next, tokens) => grantMutation.mutate({ account: next, tokens })}
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

      <AlertDialog open={!!pendingStatus} onOpenChange={(open) => { if (!open && !statusMutation.isPending) setPendingStatus(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingStatus?.status === "suspended" ? `Suspend ${pendingStatus.account.name}` : `Archive ${pendingStatus?.account.name ?? "account"}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingStatus?.status === "suspended"
                ? `${pendingStatus.account.name} loses access immediately. Its agents pause until you restore it.`
                : `${pendingStatus?.account.name ?? "This account"} stays in the database but leaves ordinary queries. Its agents pause and access turns off.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={statusMutation.isPending || !pendingStatus}
              onClick={(event) => {
                event.preventDefault();
                if (pendingStatus) statusMutation.mutate(pendingStatus);
              }}
            >
              {statusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : pendingStatus?.status === "suspended" ? "Suspend" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) { setPendingDelete(null); setConfirmation(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.account.name ?? "account"}</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently wipes {pendingDelete?.account.name ?? "this account"} ({pendingDelete?.email ?? "this customer"}) and cannot be recovered. Type <span className="font-mono text-foreground">{expectedDelete}</span> to continue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={expectedDelete}
            autoComplete="off"
            data-testid="input-delete-account-confirmation"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={confirmation !== expectedDelete || deleteMutation.isPending || !pendingDelete}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) deleteMutation.mutate({ account: pendingDelete.account, confirmation });
              }}
              data-testid="button-delete-account-confirm"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
