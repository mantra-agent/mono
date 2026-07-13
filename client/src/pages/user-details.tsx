import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bot, Check, Clock, KeyRound, Loader2, LogOut, Mail, Monitor, Save, X } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { useUiScale } from "@/hooks/use-ui-scale";
import { createLogger } from "@/lib/logger";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const log = createLogger("Account");

export default function UserDetailsPage() {
  usePageHeader({ title: "Account" });
  const { user } = useAuth();
  const logout = useLogout();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
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

  return (
    <div className="flex h-full min-w-0 flex-col overflow-auto bg-background" data-testid="account-page">
      <div className="flex items-center justify-end p-2">
        <Button size="icon" variant="ghost" onClick={() => setLocation("/home")} data-testid="button-close-account" aria-label="Close account">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-0 px-2 pb-4">
        <ProfileTreeRow
          label="Email"
          icon={<Mail className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          defaultOpen
          testId="account-email-row"
          expandedContent={(
            <div className="max-w-xl space-y-3 py-1">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs">Email address</Label>
                <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} data-testid="input-email" />
              </div>
              <Button
                size="sm"
                onClick={() => email.trim() && updateProfile.mutate({ email: email.trim() })}
                disabled={updateProfile.isPending || !email.trim() || email.trim() === user.email}
                data-testid="button-save-profile"
              >
                {updateProfile.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          )}
        >
          <span className="max-w-48 truncate text-foreground">{user.email}</span>
        </ProfileTreeRow>

        <ProfileTreeRow
          label="Password"
          icon={<KeyRound className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          testId="account-password-row"
          expandedContent={(
            <div className="max-w-xl space-y-3 py-1">
              <div className="space-y-1.5">
                <Label htmlFor="currentPassword" className="text-xs">Current password</Label>
                <Input id="currentPassword" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} data-testid="input-current-password" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="newPassword" className="text-xs">New password</Label>
                <Input id="newPassword" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} data-testid="input-new-password" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword" className="text-xs">Confirm new password</Label>
                <Input id="confirmPassword" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} data-testid="input-confirm-password" />
              </div>
              <Button size="sm" onClick={handleChangePassword} disabled={changePassword.isPending || !currentPassword || !newPassword || !confirmPassword} data-testid="button-change-password">
                {changePassword.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Change password
              </Button>
            </div>
          )}
        >
          <span className="text-muted-foreground">••••••••</span>
        </ProfileTreeRow>

        <DisplayTreeRow />
        <MeetingAgentTreeRow />
        <TimezoneTreeRow />

        <ProfileTreeRow
          label="Log out"
          icon={<LogOut className="h-3.5 w-3.5 text-destructive" />}
          hasValue
          showEmpty
          actionContent={(
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
          )}
        >
          <span className="text-muted-foreground">End session</span>
        </ProfileTreeRow>
      </div>
    </div>
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
      toast({ title: "Timezone updated", description: `Set to ${result.timezone}. Agent restarting to apply.` });
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
