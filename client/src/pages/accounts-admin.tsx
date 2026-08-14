import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Building2, ChevronRight, Loader2, MoreHorizontal } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useToast } from "@/hooks/use-toast";
import {
  accountDeleteConfirmation,
  accountSection,
  IDENTITY_GRAPH_QUERY_KEY,
  matchesIdentityQuery,
  useIdentityGraph,
  type AccountLifecycleStatus,
  type IdentityGraphAccount,
  type IdentityGraphInstance,
  type IdentityGraphUser,
} from "@/lib/identity-graph";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createReferenceRef } from "@shared/references";

const ACCOUNT_SECTIONS: Array<{ id: AccountLifecycleStatus; label: string; defaultOpen: boolean; lazy: boolean }> = [
  { id: "active", label: "ACTIVE", defaultOpen: true, lazy: false },
  { id: "suspended", label: "SUSPENDED", defaultOpen: true, lazy: false },
  { id: "archived", label: "ARCHIVED", defaultOpen: false, lazy: true },
];

function ownerEmail(account: IdentityGraphAccount, users: IdentityGraphUser[]): string {
  return users.find((user) => user.id === account.ownerUserId)?.email
    ?? users[0]?.email
    ?? "unknown";
}

function AccountRow({
  account,
  users,
  instances,
  defaultOpen,
  canWrite,
  onStatus,
  onDelete,
}: {
  account: IdentityGraphAccount;
  users: IdentityGraphUser[];
  instances: IdentityGraphInstance[];
  defaultOpen: boolean;
  canWrite: boolean;
  onStatus: (account: IdentityGraphAccount, status: AccountLifecycleStatus) => void;
  onDelete: (account: IdentityGraphAccount, email: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
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

  return (
    <div className="min-w-0" data-testid={`account-row-${account.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/70">
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{account.name}</span>
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
        children.length === 0 ? (
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <div className="px-2 py-1.5 text-sm text-muted-foreground">No members or agents.</div>
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

export default function AccountsAdminPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission("users:read");
  const canWrite = hasPermission("users:write");
  const { data, isLoading } = useIdentityGraph(canRead);
  const [search, setSearch] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<IdentityGraphAccount | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ account: IdentityGraphAccount; email: string } | null>(null);
  const [confirmation, setConfirmation] = useState("");
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
    mutationFn: async ({ accountId, status }: { accountId: string; status: AccountLifecycleStatus }) => {
      await apiRequest("PATCH", `/api/auth/accounts/${accountId}/status`, { status });
    },
    onSuccess: async (_result, variables) => {
      await invalidate();
      setPendingArchive(null);
      toast({ title: variables.status === "active" ? "Account restored" : `Account ${variables.status}` });
    },
    onError: (error: Error) => toast({ title: "Could not update account", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ accountId, confirmation: typed }: { accountId: string; confirmation: string }) => {
      await apiRequest("DELETE", `/api/auth/accounts/${accountId}`, { confirmation: typed });
    },
    onSuccess: async () => {
      await invalidate();
      setPendingDelete(null);
      setConfirmation("");
      toast({ title: "Account deleted" });
    },
    onError: (error: Error) => toast({ title: "Could not delete account", description: error.message, variant: "destructive" }),
  });

  const requestStatus = (account: IdentityGraphAccount, status: AccountLifecycleStatus) => {
    if (status === "archived") {
      setPendingArchive(account);
      return;
    }
    statusMutation.mutate({ accountId: account.id, status });
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
            const rows = accounts.filter((account) => accountSection(account.status) === section.id);
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
                          onStatus={requestStatus}
                          onDelete={(next, email) => setPendingDelete({ account: next, email })}
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

      <AlertDialog open={!!pendingArchive} onOpenChange={(open) => { if (!open && !statusMutation.isPending) setPendingArchive(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive account</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingArchive?.name} stays in the database but leaves ordinary queries. Its agents pause and access turns off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={statusMutation.isPending || !pendingArchive}
              onClick={(event) => {
                event.preventDefault();
                if (pendingArchive) statusMutation.mutate({ accountId: pendingArchive.id, status: "archived" });
              }}
            >
              {statusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !deleteMutation.isPending) { setPendingDelete(null); setConfirmation(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently wipes {pendingDelete?.email ?? "this customer"} and cannot be recovered. Type <span className="font-mono text-foreground">{expectedDelete}</span> to continue.
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
                if (pendingDelete) deleteMutation.mutate({ accountId: pendingDelete.account.id, confirmation });
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
