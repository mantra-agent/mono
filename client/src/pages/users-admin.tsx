import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Glasses, Globe2, Loader2, Shield, Smartphone, User, Users } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import type { ClientPresenceEntry, ClientPresenceKind } from "@shared/client-presence";

interface AdminUserRow {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  hasPendingInvite: boolean;
  permissions: string[];
  permissionOverrides: string[];
  presence: ClientPresenceEntry[];
}

interface UsersResponse {
  users: AdminUserRow[];
  availablePermissions: string[];
}

interface UserGroupSectionProps {
  label: string;
  count: number;
  defaultOpen: boolean;
  storageKey: string;
  children: ReactNode;
}

const KIND_LABEL: Record<ClientPresenceKind, string> = {
  web: "Web",
  ios: "Mobile",
  glasses: "Glasses",
};

const KIND_ORDER: Record<ClientPresenceKind, number> = { web: 0, ios: 1, glasses: 2 };

function labelForPermission(permission: string): string {
  return permission.replace(":", " ");
}

function PresenceIcon({ kind, className = "h-3.5 w-3.5" }: { kind: ClientPresenceKind; className?: string }) {
  if (kind === "ios") return <Smartphone className={className} />;
  if (kind === "glasses") return <Glasses className={className} />;
  return <Globe2 className={className} />;
}

function connectedKinds(presence: ClientPresenceEntry[]): ClientPresenceKind[] {
  return Array.from(new Set(presence.map((client) => client.kind))).sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);
}

function UserPresence({ presence, showLabels = false }: { presence: ClientPresenceEntry[]; showLabels?: boolean }) {
  const kinds = useMemo(() => connectedKinds(presence), [presence]);
  if (kinds.length === 0) return <span className="text-xs text-muted-foreground">Offline</span>;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1" aria-label={`Connected clients: ${kinds.map((kind) => KIND_LABEL[kind]).join(", ")}`}>
      {kinds.map((kind) => (
        <span
          key={kind}
          className={cn(
            "flex items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground",
            showLabels ? "h-7 gap-1.5 px-2 text-xs" : "h-7 w-7",
          )}
          title={`${KIND_LABEL[kind]} connected`}
        >
          <PresenceIcon kind={kind} />
          {showLabels ? KIND_LABEL[kind] : null}
        </span>
      ))}
    </div>
  );
}

function UserGroupSection({ label, count, defaultOpen, storageKey, children }: UserGroupSectionProps) {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    return stored === null ? defaultOpen : stored === "true";
  });

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    window.localStorage.setItem(storageKey, String(nextOpen));
  }, [storageKey]);

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} <span className="font-normal">({count})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5 space-y-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function UserDetail({
  user,
  availablePermissions,
  canWrite,
  draft,
  onDraftChange,
  onBack,
}: {
  user: AdminUserRow;
  availablePermissions: string[];
  canWrite: boolean;
  draft: Set<string>;
  onDraftChange: (next: Set<string>) => void;
  onBack: () => void;
}) {
  const mutation = useMutation({
    mutationFn: async (permissions: string[]) => {
      const res = await apiRequest("PATCH", `/api/auth/users/${user.id}/permissions`, { permissions });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });

  const dirty = Array.from(draft).sort().join("|") !== [...user.permissionOverrides].sort().join("|");
  const created = new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="p-4" data-testid={`user-detail-${user.id}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 @md:hidden" onClick={onBack} aria-label="Back to users">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-foreground">{user.email}</h2>
            <p className="text-sm capitalize text-muted-foreground">{user.role}{user.hasPendingInvite ? " · Invite pending" : ""}</p>
          </div>
        </div>
        <Button
          size="sm"
          disabled={!canWrite || !dirty || mutation.isPending}
          onClick={() => mutation.mutate(Array.from(draft))}
        >
          {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>

      <div className="space-y-1">
        <ProfileTreeRow label="Status" icon={<User className="h-3.5 w-3.5" />} hasValue showEmpty>
          <span className={user.presence.length > 0 ? "text-foreground" : "text-muted-foreground"}>
            {user.presence.length > 0 ? "Active" : "Inactive"}
          </span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Connections" icon={<Globe2 className="h-3.5 w-3.5" />} hasValue={user.presence.length > 0} showEmpty>
          <UserPresence presence={user.presence} showLabels />
        </ProfileTreeRow>
        <ProfileTreeRow label="Role" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty>
          <span className="capitalize text-foreground">{user.role}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Joined" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty>
          <span className="text-foreground">{created}</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Permissions"
          icon={<Shield className="h-3.5 w-3.5" />}
          hasValue={availablePermissions.length > 0}
          showEmpty
          defaultOpen
          expandedContentClassName="pt-1"
          expandedContent={(
            <div className="grid gap-2 @sm:grid-cols-2 @lg:grid-cols-3">
              {availablePermissions.map((permission) => {
                const inherited = user.permissions.includes(permission) && !user.permissionOverrides.includes(permission);
                const checked = inherited || draft.has(permission);
                return (
                  <label key={permission} className="flex min-h-11 items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                    <Checkbox
                      checked={checked}
                      disabled={!canWrite || inherited}
                      onCheckedChange={(value) => {
                        const next = new Set(draft);
                        if (value) next.add(permission); else next.delete(permission);
                        onDraftChange(next);
                      }}
                    />
                    <span className="capitalize text-foreground">{labelForPermission(permission)}</span>
                    {inherited ? <span className="text-xs text-muted-foreground">inherited</span> : null}
                  </label>
                );
              })}
            </div>
          )}
        >
          <span className="text-foreground">{user.permissions.length}</span>
        </ProfileTreeRow>
      </div>
    </div>
  );
}

export default function UsersAdminPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("users:write");
  const canRead = hasPermission("users:read");
  const { data, isLoading } = useQuery<UsersResponse>({
    queryKey: ["/api/auth/users"],
    enabled: canRead,
    refetchInterval: 15_000,
  });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});

  usePageHeader({ title: "Users" });

  const availablePermissions = data?.availablePermissions ?? [];
  const users = data?.users ?? [];
  const activeUsers = useMemo(() => users.filter((user) => user.presence.length > 0), [users]);
  const inactiveUsers = useMemo(() => users.filter((user) => user.presence.length === 0), [users]);
  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;

  const draftFor = useCallback((user: AdminUserRow) => drafts[user.id] ?? new Set(user.permissionOverrides), [drafts]);
  const selectUser = useCallback((userId: string) => setSelectedUserId(userId), []);

  if (!canRead) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Users administration requires users:read.</div>;
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const renderUserRow = (user: AdminUserRow) => {
    const selected = selectedUserId === user.id;
    return (
      <button
        key={user.id}
        type="button"
        onClick={() => selectUser(user.id)}
        className={cn(
          "group flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/70",
        )}
        data-testid={`user-row-${user.id}`}
      >
        <User className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-foreground" : "text-muted-foreground")} />
        <span className={cn("min-w-0 flex-1 truncate", selected ? "text-foreground" : "text-muted-foreground")}>{user.email}</span>
        {user.presence.length > 0 ? <UserPresence presence={user.presence} /> : null}
      </button>
    );
  };

  return (
    <div className="flex h-full bg-black" data-testid="users-page">
      <div className={cn("w-full shrink-0 flex-col bg-black @md:flex @md:w-72", selectedUser ? "hidden" : "flex")}>
        <ScrollArea className="flex-1">
          <div className="space-y-1 p-2">
            {users.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No users yet.</div>
            ) : (
              <>
                <UserGroupSection label="Active" count={activeUsers.length} defaultOpen storageKey="users:list:active:open">
                  {activeUsers.length > 0 ? activeUsers.map(renderUserRow) : <div className="px-7 py-1.5 text-sm text-muted-foreground">No active users.</div>}
                </UserGroupSection>
                <UserGroupSection label="Inactive" count={inactiveUsers.length} defaultOpen={false} storageKey="users:list:inactive:open">
                  {inactiveUsers.map(renderUserRow)}
                </UserGroupSection>
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className={cn("min-w-0 flex-1 flex-col", selectedUser ? "flex" : "hidden @md:flex")}>
        {selectedUser ? (
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            <UserDetail
              user={selectedUser}
              availablePermissions={availablePermissions}
              canWrite={canWrite}
              draft={draftFor(selectedUser)}
              onDraftChange={(next) => setDrafts((current) => ({ ...current, [selectedUser.id]: next }))}
              onBack={() => setSelectedUserId(null)}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a user to view their access.</p>
          </div>
        )}
      </div>
    </div>
  );
}
