import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Clock, Copy, Glasses, Globe2, Loader2, Mail, Monitor, MoreHorizontal, Shield, Smartphone, Trash2, User, UserPlus, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { formatDateTime as formatDateTimeInTimezone, useTimezone } from "@/hooks/use-timezone";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { matchesIdentityQuery, useIdentityGraph } from "@/lib/identity-graph";
import { createReferenceRef } from "@shared/references";
import type { ClientPresenceEntry, ClientPresenceKind } from "@shared/client-presence";

interface AdminUserRow {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
  lastLoginAt: string | null;
  hasPendingInvite: boolean;
  permissions: string[];
  permissionOverrides: string[];
  presence: ClientPresenceEntry[];
  identityIncomplete?: boolean;
}

interface UserSessionRow {
  sid: string;
  createdAt: string | null;
  lastActiveAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  clientIp: string | null;
  current: boolean;
}

interface UserSessionsResponse {
  userId: string;
  sessions: UserSessionRow[];
}

interface WaitlistApplicationRow {
  id: string;
  email: string;
  position: number;
  status: string;
  role: string;
  needs: string[];
  readiness: string;
  source: string | null;
  attribution: Record<string, unknown>;
  confirmationEmailStatus: string;
  createdAt: string;
  updatedAt: string;
}

interface UsersResponse {
  users: AdminUserRow[];
  waitlist: WaitlistApplicationRow[];
  availablePermissions: string[];
}

interface InviteResult {
  email: string;
  token: string;
  expiresAt: string;
}

interface UserGroupSectionProps {
  label: string;
  count: number;
  defaultOpen: boolean;
  storageKey: string;
  children: ReactNode;
}

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const KIND_LABEL: Record<ClientPresenceKind, string> = { web: "Web", ios: "Mobile", glasses: "Glasses" };
const KIND_ORDER: Record<ClientPresenceKind, number> = { web: 0, ios: 1, glasses: 2 };

function labelForPermission(permission: string): string {
  return permission.replace(":", " ");
}

function summarizeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent?.trim()) return "Unknown device";
  const ua = userAgent.trim();
  if (ua === "mantra-screenshot-session") return "Screenshot session";
  const browser =
    /Edg\//.test(ua) ? "Edge"
      : /Chrome\//.test(ua) ? "Chrome"
        : /Firefox\//.test(ua) ? "Firefox"
          : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? "Safari"
            : null;
  const os =
    /iPhone|iPad/.test(ua) ? "iOS"
      : /Android/.test(ua) ? "Android"
        : /Mac OS X/.test(ua) ? "macOS"
          : /Windows/.test(ua) ? "Windows"
            : /Linux/.test(ua) ? "Linux"
              : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 48 ? `${ua.slice(0, 45)}…` : ua;
}

function formatSessionRelative(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDistanceToNow(date, { addSuffix: true });
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
        <span key={kind} className={cn("flex items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground", showLabels ? "h-7 gap-1.5 px-2 text-xs" : "h-7 w-7")} title={`${KIND_LABEL[kind]} connected`}>
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
      <CollapsibleContent><div className="mt-0 space-y-0">{children}</div></CollapsibleContent>
    </Collapsible>
  );
}

function InviteUserDialog({ open, onOpenChange }: InviteUserDialogProps) {
  const { timezone } = useTimezone();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [syntheticConfirmed, setSyntheticConfirmed] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/auth/invite", { email: email.trim() })).json() as Promise<InviteResult>,
    onSuccess: (nextResult) => {
      setResult(nextResult);
      toast({ title: "Invite created", description: "No email was sent." });
    },
    onError: (error: Error) => toast({ title: "Could not create invite", description: error.message, variant: "destructive" }),
  });
  const registrationUrl = result ? `${window.location.origin}/register/${result.token}` : "";
  const reset = () => {
    setEmail("");
    setSyntheticConfirmed(false);
    setResult(null);
    setCopied(false);
    invite.reset();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !invite.isPending) {
      const shouldRefreshUsers = result !== null;
      reset();
      onOpenChange(false);
      if (shouldRefreshUsers) void queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      return;
    }
    onOpenChange(nextOpen);
  };
  const copyRegistrationUrl = async () => {
    try {
      await navigator.clipboard.writeText(registrationUrl);
      setCopied(true);
      toast({ title: "Registration link copied" });
    } catch (error) {
      toast({ title: "Could not copy link", description: error instanceof Error ? error.message : "Clipboard unavailable", variant: "destructive" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (result) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (result) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{result ? "Invite created" : "Invite synthetic user"}</DialogTitle>
          <DialogDescription>
            {result ? "Copy this bearer link into the synthetic rehearsal browser. No email was sent." : "This action creates a pending synthetic account and returns its registration link. It never sends email."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="invite-registration-url" className="text-sm font-medium text-foreground">Registration link</label>
              <div className="flex gap-2">
                <Input id="invite-registration-url" value={registrationUrl} readOnly className="font-mono text-xs" data-testid="input-invite-registration-url" />
                <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={copyRegistrationUrl} aria-label="Copy registration link" data-testid="button-copy-invite-link">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">Expires {formatDateTimeInTimezone(result.expiresAt, timezone, { year: "numeric" })}.</p>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)} data-testid="button-finish-invite">Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}>
            <div className="space-y-2">
              <label htmlFor="invite-email" className="text-sm font-medium text-foreground">Synthetic email</label>
              <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="beremie@example.com" autoComplete="off" required autoFocus data-testid="input-invite-email" />
            </div>
            <label className="flex min-h-11 items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm text-foreground">
              <Checkbox checked={syntheticConfirmed} onCheckedChange={(value) => setSyntheticConfirmed(value === true)} />
              I confirm this is a synthetic rehearsal identity.
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={invite.isPending}>Cancel</Button>
              <Button type="submit" disabled={!email.trim() || !syntheticConfirmed || invite.isPending} data-testid="button-create-invite">
                {invite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({ user, open, onOpenChange, onDeleted }: { user: AdminUserRow | null; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void }) {
  const { toast } = useToast();
  const [confirmation, setConfirmation] = useState("");
  const expected = user ? `DELETE ${user.email}` : "";
  const deletion = useMutation({
    mutationFn: async () => {
      if (!user) return;
      await apiRequest("DELETE", `/api/auth/users/${user.id}`, { confirmation });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      setConfirmation("");
      onOpenChange(false);
      onDeleted();
      toast({ title: "User deleted" });
    },
    onError: (error: Error) => toast({ title: "Could not delete user", description: error.message, variant: "destructive" }),
  });
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !deletion.isPending) setConfirmation("");
    onOpenChange(nextOpen);
  };
  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete user</AlertDialogTitle>
          <AlertDialogDescription>This permanently deletes {user?.email}. Type <span className="font-mono text-foreground">{expected}</span> to continue.</AlertDialogDescription>
        </AlertDialogHeader>
        <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={expected} autoComplete="off" data-testid="input-delete-user-confirmation" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletion.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={confirmation !== expected || deletion.isPending} onClick={(event) => { event.preventDefault(); deletion.mutate(); }} data-testid="button-delete-user-confirm">
            {deletion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete user"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}


const WAITLIST_STATUS_OPTIONS = ["waiting", "reviewing", "invited", "deferred", "declined"];
const WAITLIST_LABELS: Record<string, string> = {
  founder: "Founder or business owner", executive: "Executive or operator", investor: "Investor",
  coach: "Coach or advisor", creator: "Creator", other: "Other",
  priorities: "Priorities and follow-through", work: "Work and projects", relationships: "Relationships and communication",
  decisions: "Decisions and knowledge", health: "Health and energy", money: "Money and planning", connection: "Keeping everything connected",
  ready: "Ready now", possible: "Possible if valuable", lower_cost: "Prefers a lower-cost plan", curious: "Mainly curious",
};

function WaitlistDetail({ application, canWrite }: { application: WaitlistApplicationRow; canWrite: boolean }) {
  const { timezone } = useTimezone();
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (status: string) => (await apiRequest("PATCH", `/api/admin/waitlist/${application.id}`, { status })).json(),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] }); toast({ title: "Waitlist status updated" }); },
    onError: (error: Error) => toast({ title: "Could not update status", description: error.message, variant: "destructive" }),
  });
  return (
    <div className="space-y-0">
      <ProfileTreeRow label="Role" icon={<User className="h-3.5 w-3.5" />} hasValue showEmpty><span>{WAITLIST_LABELS[application.role] || application.role}</span></ProfileTreeRow>
      <ProfileTreeRow label="Needs" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty expandedContent={<div className="space-y-1 text-sm text-foreground">{application.needs.map((need) => <div key={need}>{WAITLIST_LABELS[need] || need}</div>)}</div>}><span>{application.needs.length}</span></ProfileTreeRow>
      <ProfileTreeRow label="Readiness" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty><span>{WAITLIST_LABELS[application.readiness] || application.readiness}</span></ProfileTreeRow>
      <ProfileTreeRow label="Source" icon={<Globe2 className="h-3.5 w-3.5" />} hasValue={!!application.source} showEmpty><span>{application.source || "Direct"}</span></ProfileTreeRow>
      <ProfileTreeRow label="Email" icon={<Mail className="h-3.5 w-3.5" />} hasValue showEmpty><span className="capitalize">{application.confirmationEmailStatus}</span></ProfileTreeRow>
      <ProfileTreeRow label="Applied" icon={<Clock className="h-3.5 w-3.5" />} hasValue showEmpty><span>{formatDateTimeInTimezone(application.createdAt, timezone, { year: "numeric" })}</span></ProfileTreeRow>
      <ProfileTreeRow label="Status" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty expandedContent={<div className="flex flex-wrap gap-2">{WAITLIST_STATUS_OPTIONS.map((status) => <Button key={status} size="sm" variant={application.status === status ? "default" : "outline"} disabled={!canWrite || mutation.isPending || application.status === status} onClick={() => mutation.mutate(status)} className="capitalize">{status}</Button>)}</div>}><span className="capitalize">{application.status}</span></ProfileTreeRow>
    </div>
  );
}

function UserDetail({ user, availablePermissions, canWrite, draft, onDraftChange }: { user: AdminUserRow; availablePermissions: string[]; canWrite: boolean; draft: Set<string>; onDraftChange: (next: Set<string>) => void }) {
  const { timezone } = useTimezone();
  const { toast } = useToast();
  const [revokingSid, setRevokingSid] = useState<string | null>(null);
  const sessionsQueryKey = ["/api/auth/users", user.id, "sessions"] as const;
  const sessionsQuery = useQuery<UserSessionsResponse>({
    queryKey: sessionsQueryKey,
    queryFn: async () => (await apiRequest("GET", `/api/auth/users/${user.id}/sessions`)).json(),
  });
  const mutation = useMutation({
    mutationFn: async (permissions: string[]) => (await apiRequest("PATCH", `/api/auth/users/${user.id}/permissions`, { permissions })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
  });
  const repairIdentityMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/auth/users/${user.id}/identity-foundation`)).json(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/users"] });
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      toast({ title: "Account setup repaired", description: `${user.email} can sign in again with a personal Vault.` });
    },
    onError: (error: Error) => {
      toast({ title: "Could not repair account setup", description: error.message, variant: "destructive" });
    },
  });
  const revokeSessionMutation = useMutation({
    mutationFn: async (sid: string) => {
      setRevokingSid(sid);
      return (await apiRequest("DELETE", `/api/auth/users/${user.id}/sessions/${encodeURIComponent(sid)}`)).json() as Promise<{ ok: boolean; revokedCurrent?: boolean }>;
    },
    onSuccess: async (result) => {
      if (result.revokedCurrent) {
        toast({ title: "Current session revoked", description: "Sign in again to continue." });
        window.location.assign("/login");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      toast({ title: "Session revoked" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not revoke session", description: error.message, variant: "destructive" });
    },
    onSettled: () => setRevokingSid(null),
  });
  const dirty = Array.from(draft).sort().join("|") !== [...user.permissionOverrides].sort().join("|");
  const created = new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const sessions = sessionsQuery.data?.sessions ?? [];
  return (
    <div data-testid={`user-detail-${user.id}`}>
      {dirty ? (
        <div className="flex justify-end px-2 py-1">
          <Button size="sm" disabled={!canWrite || mutation.isPending} onClick={() => mutation.mutate(Array.from(draft))}>{mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}</Button>
        </div>
      ) : null}
      <div className="space-y-0">
        <ProfileTreeRow
          label="Account Setup"
          icon={<Shield className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          defaultOpen={user.identityIncomplete}
          expandedContent={
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Re-runs personal Account and Vault setup, then signs this user out.</p>
              <Button size="sm" variant="outline" disabled={!canWrite || repairIdentityMutation.isPending} onClick={() => repairIdentityMutation.mutate()}>
                {repairIdentityMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Repair Setup
              </Button>
            </div>
          }
        >
          <span className={user.identityIncomplete ? "text-destructive" : "text-muted-foreground"}>{user.identityIncomplete ? "Incomplete" : "Ready"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Status" icon={<User className="h-3.5 w-3.5" />} hasValue showEmpty><span className={user.presence.length > 0 ? "text-foreground" : "text-muted-foreground"}>{user.presence.length > 0 ? "Active" : "Inactive"}</span></ProfileTreeRow>
        <ProfileTreeRow label="Last Active" icon={<Clock className="h-3.5 w-3.5" />} hasValue={!!user.lastActiveAt} showEmpty><span className={user.lastActiveAt ? "text-foreground" : "text-muted-foreground"}>{user.lastActiveAt ? formatDateTimeInTimezone(user.lastActiveAt, timezone, { year: "numeric" }) : "No activity yet"}</span></ProfileTreeRow>
        <ProfileTreeRow label="Connections" icon={<Globe2 className="h-3.5 w-3.5" />} hasValue={user.presence.length > 0} showEmpty><UserPresence presence={user.presence} showLabels /></ProfileTreeRow>
        <ProfileTreeRow label="Role" icon={<Shield className="h-3.5 w-3.5" />} hasValue showEmpty><span className="capitalize text-foreground">{user.role}</span></ProfileTreeRow>
        <ProfileTreeRow label="Joined" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty><span className="text-foreground">{created}</span></ProfileTreeRow>
        <ProfileTreeRow
          label="Sessions"
          icon={<Monitor className="h-3.5 w-3.5" />}
          hasValue={sessions.length > 0 || sessionsQuery.isLoading || sessionsQuery.isError}
          showEmpty
          expandedContentClassName="pt-1"
          expandedContent={
            sessionsQuery.isLoading ? (
              <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading sessions…
              </div>
            ) : sessionsQuery.isError ? (
              <p className="px-1 py-2 text-sm text-destructive">Could not load sessions.</p>
            ) : sessions.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">No active sessions.</p>
            ) : (
              <div className="space-y-2">
                {sessions.map((session) => {
                  const revoking = revokingSid === session.sid && revokeSessionMutation.isPending;
                  return (
                    <div key={session.sid} className="rounded-md border border-border/60 px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{summarizeUserAgent(session.userAgent)}</span>
                            {session.current ? (
                              <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Current
                              </span>
                            ) : null}
                          </div>
                          <div className="space-y-0.5 text-xs text-muted-foreground">
                            <div>Last active {formatSessionRelative(session.lastActiveAt)}</div>
                            <div>Signed in {formatSessionRelative(session.createdAt)}</div>
                            {session.clientIp ? <div className="font-mono">{session.clientIp}</div> : null}
                            <div>Expires {formatSessionRelative(session.expiresAt)}</div>
                          </div>
                        </div>
                        {canWrite ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={revokeSessionMutation.isPending}
                            onClick={() => revokeSessionMutation.mutate(session.sid)}
                          >
                            {revoking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                            Revoke
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          }
        >
          <span className="text-foreground">
            {sessionsQuery.isLoading ? "…" : sessions.length}
          </span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Permissions" icon={<Shield className="h-3.5 w-3.5" />} hasValue={availablePermissions.length > 0} showEmpty expandedContentClassName="pt-1" expandedContent={<div className="grid gap-2 @sm:grid-cols-2 @lg:grid-cols-3">{availablePermissions.map((permission) => { const inherited = user.permissions.includes(permission) && !user.permissionOverrides.includes(permission); const checked = inherited || draft.has(permission); return <label key={permission} className="flex min-h-11 items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"><Checkbox checked={checked} disabled={!canWrite || inherited} onCheckedChange={(value) => { const next = new Set(draft); if (value) next.add(permission); else next.delete(permission); onDraftChange(next); }} /><span className="capitalize text-foreground">{labelForPermission(permission)}</span>{inherited ? <span className="text-xs text-muted-foreground">inherited</span> : null}</label>; })}</div>}><span className="text-foreground">{user.permissions.length}</span></ProfileTreeRow>
      </div>
    </div>
  );
}

export default function UsersAdminPage() {
  const { hasPermission, user: currentUser } = useAuth();
  const canWrite = hasPermission("users:write");
  const canRead = hasPermission("users:read");
  const { data, isLoading } = useQuery<UsersResponse>({ queryKey: ["/api/auth/users"], enabled: canRead, refetchInterval: 15_000 });
  const identityGraph = useIdentityGraph(canRead);
  usePageLoadActivity("page:users", isLoading);
  const { timezone } = useTimezone();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deleteUser, setDeleteUser] = useState<AdminUserRow | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});
  const [search, setSearch] = useState("");
  const [expandedUserIds, setExpandedUserIds] = useState<Record<string, boolean>>({});
  const [expandedWaitlistIds, setExpandedWaitlistIds] = useState<Record<string, boolean>>({});
  usePageHeader({ title: "Users" });
  const availablePermissions = data?.availablePermissions ?? [];
  const users = data?.users ?? [];
  const waitlist = data?.waitlist ?? [];
  const accountsById = useMemo(
    () => new Map((identityGraph.data?.accounts ?? []).map((account) => [account.id, account])),
    [identityGraph.data?.accounts],
  );
  const instancesById = useMemo(
    () => new Map((identityGraph.data?.instances ?? []).map((instance) => [instance.id, instance])),
    [identityGraph.data?.instances],
  );
  const membershipsByUser = useMemo(() => {
    const map = new Map<string, Array<{ accountId: string; role: string }>>();
    for (const membership of identityGraph.data?.memberships ?? []) {
      const list = map.get(membership.userId) ?? [];
      list.push({ accountId: membership.accountId, role: membership.role });
      map.set(membership.userId, list);
    }
    return map;
  }, [identityGraph.data?.memberships]);
  const pinnedInstanceByUserAccount = useMemo(() => {
    const map = new Map<string, string>();
    for (const membership of identityGraph.data?.instanceMemberships ?? []) {
      map.set(`${membership.userId}:${membership.accountId}`, membership.instanceId);
    }
    return map;
  }, [identityGraph.data?.instanceMemberships]);
  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const accountNames = (membershipsByUser.get(user.id) ?? [])
        .map((membership) => accountsById.get(membership.accountId)?.name)
        .filter(Boolean);
      return matchesIdentityQuery(search, user.email, user.role, user.id, ...accountNames);
    });
  }, [accountsById, membershipsByUser, search, users]);
  const activeUsers = useMemo(() => filteredUsers.filter((user) => user.presence.length > 0), [filteredUsers]);
  const inactiveUsers = useMemo(
    () => filteredUsers
      .filter((user) => user.presence.length === 0)
      .sort((a, b) => {
        const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
        const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
        return bTime - aTime;
      }),
    [filteredUsers],
  );
  const filteredWaitlist = useMemo(
    () => waitlist.filter((application) => matchesIdentityQuery(search, application.email, application.status, application.role)),
    [search, waitlist],
  );
  const draftFor = useCallback((user: AdminUserRow) => drafts[user.id] ?? new Set(user.permissionOverrides), [drafts]);
  if (!canRead) return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Users administration requires users:read.</div>;
  if (isLoading) return null;

  const identityChildrenFor = (userId: string) => {
    const memberships = [...(membershipsByUser.get(userId) ?? [])]
      .sort((a, b) => (accountsById.get(a.accountId)?.name ?? a.accountId).localeCompare(accountsById.get(b.accountId)?.name ?? b.accountId));
    const refs = [];
    for (const membership of memberships) {
      const account = accountsById.get(membership.accountId);
      if (account) {
        refs.push(createReferenceRef({
          type: "account",
          id: account.id,
          metadata: { label: account.name },
        }));
      }
      const pinnedInstanceId = pinnedInstanceByUserAccount.get(`${userId}:${membership.accountId}`);
      const pinnedInstance = pinnedInstanceId ? instancesById.get(pinnedInstanceId) : null;
      if (pinnedInstance) {
        refs.push(createReferenceRef({
          type: "agent_instance",
          id: pinnedInstance.id,
          metadata: { label: pinnedInstance.name },
        }));
      }
    }
    return refs;
  };

  const renderWaitlistRow = (application: WaitlistApplicationRow) => {
    const expanded = expandedWaitlistIds[application.id] ?? Boolean(search.trim());
    return (
      <div key={application.id} className="min-w-0" data-testid={`waitlist-row-${application.id}`}>
        <button
          type="button"
          className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/70"
          onClick={() => setExpandedWaitlistIds((current) => ({ ...current, [application.id]: !expanded }))}
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")} />
          <span className="w-7 shrink-0 text-right text-xs tabular-nums">#{application.position}</span>
          <span className="min-w-0 flex-1 truncate">{application.email}</span>
        </button>
        {expanded ? (
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            <WaitlistDetail application={application} canWrite={canWrite} />
          </HierarchyTreeRow>
        ) : null}
      </div>
    );
  };

  const renderUserRow = (user: AdminUserRow) => {
    const expanded = expandedUserIds[user.id] ?? Boolean(search.trim());
    const children = identityChildrenFor(user.id);
    const detailContinues = false;
    return (
      <div key={user.id} className="min-w-0" data-testid={`user-row-${user.id}`}>
        <div className="group relative flex w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/70">
          <button
            type="button"
            className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={expanded ? `Collapse ${user.email}` : `Expand ${user.email}`}
            onClick={() => setExpandedUserIds((current) => ({ ...current, [user.id]: !expanded }))}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </button>
          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate pr-6 text-muted-foreground">{user.email}</span>
          {user.identityIncomplete ? <span className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive" title="Identity foundation incomplete — this account is missing its personal workspace and cannot fully sign in">Setup incomplete</span> : null}
          {user.presence.length > 0 ? <UserPresence presence={user.presence} /> : null}
          {canWrite && currentUser?.id !== user.id ? <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button type="button" className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label={`More actions for ${user.email}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteUser(user)}><Trash2 className="mr-2 h-4 w-4" />Delete user</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
        </div>
        {expanded ? (
          <>
            {children.length === 0 ? (
              <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No accounts.</div>
              </HierarchyTreeRow>
            ) : (
              children.map((ref, index) => (
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
              <ProfileTreeRow
                label="Last Login"
                icon={<Clock className="h-3.5 w-3.5" />}
                hasValue={!!user.lastLoginAt}
                showEmpty
              >
                <span className={user.lastLoginAt ? "text-foreground" : "text-muted-foreground"}>
                  {user.lastLoginAt ? formatDateTimeInTimezone(user.lastLoginAt, timezone, { year: "numeric" }) : "No login yet"}
                </span>
              </ProfileTreeRow>
            </HierarchyTreeRow>
            <HierarchyTreeRow continues={detailContinues} indent="icon" connectorAnchor="first-row-center">
              <UserDetail
                user={user}
                availablePermissions={availablePermissions}
                canWrite={canWrite}
                draft={draftFor(user)}
                onDraftChange={(next) => setDrafts((current) => ({ ...current, [user.id]: next }))}
              />
            </HierarchyTreeRow>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="users-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-users"
            clearTestId="button-clear-user-search"
            ariaLabel="Search users"
          />
          {canWrite ? <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setInviteOpen(true)} data-testid="button-invite-user"><UserPlus className="h-3.5 w-3.5" />Invite user</button> : null}
          <UserGroupSection label="Waitlist" count={filteredWaitlist.length} defaultOpen={false} storageKey="users:list:waitlist:open">{filteredWaitlist.length > 0 ? filteredWaitlist.map(renderWaitlistRow) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No one is waiting.</div>}</UserGroupSection>
          <UserGroupSection label="Active" count={activeUsers.length} defaultOpen storageKey="users:list:active:open">{activeUsers.length > 0 ? activeUsers.map(renderUserRow) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No active users.</div>}</UserGroupSection>
          <UserGroupSection label="Inactive" count={inactiveUsers.length} defaultOpen={false} storageKey="users:list:inactive:open">{inactiveUsers.length > 0 ? inactiveUsers.map(renderUserRow) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No inactive users.</div>}</UserGroupSection>
        </div>
      </div>
      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <DeleteUserDialog user={deleteUser} open={!!deleteUser} onOpenChange={(open) => { if (!open) setDeleteUser(null); }} onDeleted={() => undefined} />
    </div>
  );
}
