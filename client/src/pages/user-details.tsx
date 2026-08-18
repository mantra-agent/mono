import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, Clock, Globe2, Image, KeyRound, Loader2, LogOut, Mail, MessageSquareText, Monitor, Save, ShieldAlert } from "lucide-react";
import { ConnectionsIndicator } from "@/components/connections-indicator";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { Vault } from "@/hooks/use-vaults";
import { useAuth, useLogout, type AuthPrincipal, type AuthUser } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { useUiScale } from "@/hooks/use-ui-scale";
import { useVoiceCaptionsPreference } from "@/hooks/use-voice-captions-preference";
import { createLogger } from "@/lib/logger";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { deriveUserInitials } from "@shared/identity-name";

const log = createLogger("Account");

export default function AccountPage() {
  usePageHeader({ title: "Account" });
  const { user } = useAuth();
  const logout = useLogout();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(user?.email || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const updateProfile = useMutation({
    mutationFn: async (data: { email: string }) => {
      const res = await apiRequest("PATCH", "/api/auth/profile", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile updated" });
    },
    onError: () => toast({ title: "Failed to update profile", variant: "destructive" }),
  });

  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/auth/profile-picture", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Profile picture upload failed");
      }
      return await response.json() as { avatarObjectPath: string };
    },
    onSuccess: ({ avatarObjectPath }) => {
      queryClient.setQueryData<{ user: AuthUser; principal?: AuthPrincipal | null } | null>(["/api/auth/me"], (current) =>
        current ? { ...current, user: { ...current.user, avatarObjectPath } } : current,
      );
    },
    onError: (error: Error) => toast({
      title: "Upload failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const changePassword = useMutation({
    mutationFn: async (data: { currentPassword: string; newPassword: string }) => {
      const res = await apiRequest("POST", "/api/auth/change-password", data);
      return res.json();
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Password changed" });
    },
    onError: () => toast({ title: "Failed to change password", variant: "destructive" }),
  });

  const handleChangePassword = () => {
    if (!currentPassword || !newPassword) return;
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    changePassword.mutate({ currentPassword, newPassword });
  };

  if (!user) return null;

  const initials = deriveUserInitials({
    preferredName: user.preferredName,
    displayName: user.displayName,
    email: user.email,
  });

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto bg-background" data-testid="account-page">
      <div className="w-full min-w-0 space-y-4 px-2 py-2">
        <ProfileDetailSection title="Profile" defaultOpen testId="account-profile-section">
          <ProfileTreeRow
          label="Photo"
          icon={<Image className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="account-profile-photo-row"
          expandedContent={(
            <div className="flex min-w-0 flex-wrap items-center gap-4 py-1">
              <Avatar className="h-16 w-16 shrink-0">
                {user.avatarObjectPath && (
                  <AvatarImage src={user.avatarObjectPath} alt="Profile photo" className="object-cover" />
                )}
                <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) uploadPhoto.mutate(file);
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploadPhoto.isPending}
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-profile-photo"
              >
                {uploadPhoto.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin text-active" />}
                Upload
              </Button>
            </div>
          )}
        >
          <Avatar className="h-6 w-6 shrink-0">
            {user.avatarObjectPath && (
              <AvatarImage src={user.avatarObjectPath} alt="Profile photo" className="object-cover" />
            )}
            <AvatarFallback className="text-2xs font-semibold">{initials}</AvatarFallback>
          </Avatar>
        </ProfileTreeRow>

        <ProfileTreeRow
          label="Email"
          icon={<Mail className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="account-email-row"
        >
          <div className="flex min-w-0 items-center justify-end gap-1">
            <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} data-testid="input-email" />
            {email.trim() !== user.email && (
              <Button size="icon" variant="ghost" onClick={() => email.trim() && updateProfile.mutate({ email: email.trim() })} disabled={updateProfile.isPending || !email.trim()} data-testid="button-save-profile" aria-label="Save email">
                {updateProfile.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        </ProfileTreeRow>
        </ProfileDetailSection>

        <ProfileDetailSection title="Preferences" defaultOpen testId="account-preferences-section">
          <DisplayTreeRow />
          <VoiceCaptionsTreeRow />
          <MeetingAgentTreeRow />
          <TimezoneTreeRow />
        </ProfileDetailSection>

        <ProfileDetailSection title="Security" defaultOpen testId="account-security-section">
          <ProfileTreeRow
          label="Password"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="account-password-row"
          expandedContent={(
            <div className="space-y-2 py-1">
              <Input id="currentPassword" aria-label="Current password" placeholder="Current password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} data-testid="input-current-password" />
              <Input id="newPassword" aria-label="New password" placeholder="New password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} data-testid="input-new-password" />
              <Input id="confirmPassword" aria-label="Confirm new password" placeholder="Confirm new password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} data-testid="input-confirm-password" />
              <Button size="sm" variant="outline" onClick={handleChangePassword} disabled={changePassword.isPending || !currentPassword || !newPassword || !confirmPassword} data-testid="button-change-password">
                {changePassword.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                Change password
              </Button>
            </div>
          )}
        >
          <span className="text-muted-foreground">••••••••</span>
        </ProfileTreeRow>

        <ProfileTreeRow
          label="Connected sections"
          icon={<Globe2 className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          mobileLayout="inline"
          testId="account-connected-sections-row"
        >
          <ConnectionsIndicator emptyText="None" />
        </ProfileTreeRow>

        <ProfileTreeRow
          label="Log out"
          icon={<LogOut className="h-3.5 w-3.5 text-destructive" />}
          hasValue
          showEmpty
          mobileLayout="inline"
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            data-testid="button-logout"
          >
            {logout.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Log out"}
          </Button>
        </ProfileTreeRow>
        </ProfileDetailSection>

        <ProfileDetailSection title="Trust and Safety" defaultOpen testId="account-trust-section">
          <TrustAndSafetyTreeRow />
        </ProfileDetailSection>
      </div>
    </div>
  );
}

function TrustAndSafetyTreeRow() {
  const { toast } = useToast();
  const [pendingVault, setPendingVault] = useState<Vault | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const { data, isLoading } = useQuery<{ vaults: Vault[] }>({
    queryKey: ["/api/vaults", "includeArchived"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/vaults?includeArchived=1");
      return res.json() as Promise<{ vaults: Vault[] }>;
    },
  });
  const erase = useMutation({
    mutationFn: async (vault: Vault) => {
      const res = await apiRequest("POST", `/api/vaults/${vault.id}/permanent-delete`, {
        confirmation: "DELETE",
        idempotencyKey: crypto.randomUUID(),
      });
      return res.json() as Promise<{ erased: true; reminted: boolean }>;
    },
    onSuccess: (_result, vault) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vaults"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setPendingVault(null);
      setConfirmation("");
      toast({ title: `${vault.name} permanently deleted` });
    },
    onError: (error: Error) => {
      toast({ title: "Could not delete vault", description: error.message, variant: "destructive" });
    },
  });
  const vaults = data?.vaults ?? [];

  return (
    <>
      <ProfileTreeRow
        label="Permanent delete"
        icon={<ShieldAlert className="h-3.5 w-3.5 text-destructive" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="account-permanent-delete-row"
        expandedContent={(
          <div className="max-w-xl space-y-2 py-1">
            {isLoading ? <Skeleton className="h-9 w-full" /> : vaults.length === 0 ? (
              <p className="text-sm text-muted-foreground">No vaults.</p>
            ) : vaults.map((vault) => (
              <div key={vault.id} className="flex min-h-11 items-center justify-between gap-3 border-b border-border/40 last:border-b-0">
                <span className="min-w-0 truncate text-sm">
                  {vault.name}
                  {vault.isArchived ? <span className="ml-2 text-xs text-muted-foreground">Archived</span> : null}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => { setConfirmation(""); setPendingVault(vault); }}
                  data-testid={`button-permanent-delete-${vault.id}`}
                >
                  Delete permanently
                </Button>
              </div>
            ))}
          </div>
        )}
      >
        <span className="text-muted-foreground">{isLoading ? "Loading…" : `${vaults.length} vault${vaults.length === 1 ? "" : "s"}`}</span>
      </ProfileTreeRow>

      <Dialog
        open={pendingVault !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingVault(null);
            setConfirmation("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete {pendingVault?.name}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. Pages, sessions, meetings, and other data in this vault will be erased. Type DELETE to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
            data-testid="input-permanent-delete-confirmation"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setPendingVault(null); setConfirmation(""); }}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={confirmation !== "DELETE" || erase.isPending || !pendingVault}
              onClick={() => pendingVault && erase.mutate(pendingVault)}
              data-testid="button-confirm-permanent-delete"
            >
              {erase.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DisplayTreeRow() {
  const { scale, setScale, persistScale, DEFAULT_SCALE } = useUiScale();

  return (
    <ProfileTreeRow
      label="Display"
      icon={<Monitor className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      testId="account-display-row"
      expandedContent={(
        <div className="max-w-xl space-y-3 py-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">UI scale</Label>
            <span className="font-mono text-xs text-muted-foreground" data-testid="text-ui-scale-value">{scale}%</span>
          </div>
          <input
            type="range"
            min={90}
            max={120}
            step={1}
            value={scale}
            onChange={(event) => setScale(parseInt(event.target.value, 10))}
            onMouseUp={(event) => persistScale(parseInt((event.target as HTMLInputElement).value, 10))}
            onTouchEnd={(event) => persistScale(parseInt((event.target as HTMLInputElement).value, 10))}
            className="w-full accent-primary"
            data-testid="input-ui-scale"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>90%</span>
            <button className="transition-colors hover:text-foreground" onClick={() => { setScale(DEFAULT_SCALE); persistScale(DEFAULT_SCALE); }} data-testid="button-reset-ui-scale">
              Default ({DEFAULT_SCALE}%)
            </button>
            <span>120%</span>
          </div>
          <p className="text-xs text-muted-foreground">Scales all text, spacing, and buttons. Syncs across devices.</p>
        </div>
      )}
    >
      <span className="text-foreground">{scale}%</span>
    </ProfileTreeRow>
  );
}

function VoiceCaptionsTreeRow() {
  const { voiceCaptions, isLoading, isSaving, setVoiceCaptions } = useVoiceCaptionsPreference();

  return (
    <ProfileTreeRow
      label="Voice captions"
      icon={<MessageSquareText className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      testId="account-voice-captions-row"
      actionContent={isLoading ? <Skeleton className="h-6 w-10" /> : (
        <Switch
          checked={voiceCaptions}
          disabled={isSaving}
          onCheckedChange={setVoiceCaptions}
          aria-label="Show synchronized voice captions"
          data-testid="switch-voice-captions"
        />
      )}
    >
      <span className="text-foreground">{voiceCaptions ? "On" : "Off"}</span>
    </ProfileTreeRow>
  );
}

type MeetingJoinPolicy = "all" | "only_toggled" | "exclude_external";

const MEETING_JOIN_POLICY_OPTIONS: Array<{ value: MeetingJoinPolicy; label: string; description: string }> = [
  { value: "all", label: "All meetings", description: "Join every Zoom or Google Meet event automatically." },
  { value: "exclude_external", label: "Internal meetings", description: "Join automatically unless an attendee uses another email domain." },
  { value: "only_toggled", label: "Only toggled", description: "Join only events you explicitly turn on from Home." },
];

function MeetingAgentTreeRow() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ policy: MeetingJoinPolicy }>({ queryKey: ["/api/auth/meeting-join-policy"] });
  const mutation = useMutation({
    mutationFn: async (policy: MeetingJoinPolicy) => {
      const response = await apiRequest("PUT", "/api/auth/meeting-join-policy", { policy });
      return response.json();
    },
    onSuccess: (result: { policy: MeetingJoinPolicy }) => {
      queryClient.setQueryData(["/api/auth/meeting-join-policy"], result);
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
      toast({ title: "Meeting join policy updated" });
    },
    onError: (error: Error) => {
      log.error("meeting join policy update failed:", error);
      toast({ title: "Could not update meeting policy", description: error.message, variant: "destructive" });
    },
  });
  const current = data?.policy ?? "only_toggled";
  const currentLabel = MEETING_JOIN_POLICY_OPTIONS.find((option) => option.value === current)?.label ?? "Only toggled";

  return (
    <ProfileTreeRow
      label="Meeting agent"
      icon={<Bot className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      testId="account-meeting-agent-row"
      expandedContent={(
        <div className="max-w-xl space-y-3 py-1">
          <p className="text-xs text-muted-foreground">Per-event controls on Home override this policy in either direction.</p>
          {isLoading ? <Skeleton className="h-28 w-full" /> : (
            <div className="overflow-hidden rounded-md border border-border">
              {MEETING_JOIN_POLICY_OPTIONS.map((option) => {
                const selected = current === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => !selected && mutation.mutate(option.value)}
                    className={cn("flex min-h-11 w-full items-start gap-3 border-b border-border/40 px-3 py-2 text-left last:border-b-0 hover:bg-accent/50", selected && "bg-accent/40")}
                    aria-pressed={selected}
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border">{selected ? <span className="h-2 w-2 rounded-full bg-cta" /> : null}</span>
                    <span className="min-w-0"><span className="block text-sm font-medium">{option.label}</span><span className="block text-xs text-muted-foreground">{option.description}</span></span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    >
      <span className="text-foreground">{isLoading ? "Loading…" : currentLabel}</span>
    </ProfileTreeRow>
  );
}

const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Phoenix", "America/Toronto",
  "America/Vancouver", "America/Mexico_City", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Europe/Amsterdam", "Europe/Madrid", "Europe/Rome", "Europe/Moscow", "Europe/Istanbul", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai",
  "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Asia/Hong_Kong", "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland", "Africa/Cairo",
  "Africa/Johannesburg", "Africa/Lagos",
];

function getAllTimezones(): string[] {
  try {
    return (Intl as typeof Intl & { supportedValuesOf: (key: "timeZone") => string[] }).supportedValuesOf("timeZone");
  } catch {
    return COMMON_TIMEZONES;
  }
}

function formatTimezoneOffset(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" });
    return formatter.formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

function TimezoneTreeRow() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useQuery<{ timezone: string; localTime: string }>({ queryKey: ["/api/settings/timezone"] });
  const mutation = useMutation({
    mutationFn: async (timezone: string) => {
      const res = await apiRequest("PUT", "/api/settings/timezone", { timezone });
      return res.json();
    },
    onSuccess: (result: { timezone: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/timezone"] });
      toast({ title: "Timezone updated", description: `Set to ${result.timezone}.` });
    },
    onError: (error: Error) => {
      log.error("timezone update failed:", error);
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
  const allTimezones = useMemo(() => getAllTimezones(), []);
  const filteredTimezones = useMemo(() => {
    const source = showAll ? allTimezones : COMMON_TIMEZONES;
    const query = search.trim().toLowerCase();
    return query ? source.filter((timezone) => timezone.toLowerCase().includes(query)) : source;
  }, [allTimezones, search, showAll]);
  const currentTimezone = data?.timezone || "America/New_York";

  return (
    <ProfileTreeRow
      label="Timezone"
      icon={<Clock className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      testId="account-timezone-row"
      expandedContent={(
        <div className="max-w-xl space-y-3 py-1">
          {isLoading ? <Skeleton className="h-9 w-full" /> : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground" data-testid="badge-current-timezone">{currentTimezone}</span>
                <span className="text-muted-foreground" data-testid="text-local-time">{data?.localTime || ""}</span>
              </div>
              <Input placeholder="Search timezones..." value={search} onChange={(event) => setSearch(event.target.value)} data-testid="input-timezone-search" />
              <div className="flex items-center gap-2">
                <Button variant={showAll ? "default" : "outline"} size="sm" onClick={() => setShowAll(!showAll)} data-testid="button-toggle-all-timezones">{showAll ? "Common" : "Show all"}</Button>
                <span className="text-xs text-muted-foreground">{filteredTimezones.length} timezone{filteredTimezones.length === 1 ? "" : "s"}</span>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                {filteredTimezones.length === 0 ? <div className="p-4 text-center text-sm text-muted-foreground">No matching timezones</div> : filteredTimezones.map((timezone) => {
                  const active = timezone === currentTimezone;
                  return (
                    <button
                      key={timezone}
                      onClick={() => !active && mutation.mutate(timezone)}
                      disabled={mutation.isPending}
                      className={cn("flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50", active && "bg-accent/50")}
                      data-testid={`button-timezone-${timezone.replace(/\//g, "-")}`}
                    >
                      <span className="flex items-center gap-2">{active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}<span className={active ? "font-medium" : ""}>{timezone.replace(/_/g, " ")}</span></span>
                      <span className="font-mono text-xs text-muted-foreground">{formatTimezoneOffset(timezone)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">Used by the agent, voice sessions, and dashboard displays.</p>
            </>
          )}
        </div>
      )}
    >
      <span className="max-w-48 truncate text-foreground">{isLoading ? "Loading…" : currentTimezone}</span>
    </ProfileTreeRow>
  );
}
