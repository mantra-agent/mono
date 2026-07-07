import { useState, useMemo } from "react";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePageHeader } from "@/hooks/use-page-header";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LogOut, Loader2, Save, X, Clock, Check, Monitor } from "lucide-react";
import { useUiScale } from "@/hooks/use-ui-scale";
import { createLogger } from "@/lib/logger";

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
    onError: () => {
      toast({ title: "Failed to update profile", variant: "destructive" });
    },
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
    onError: () => {
      toast({ title: "Failed to change password", variant: "destructive" });
    },
  });

  const handleSaveProfile = () => {
    if (!email.trim()) return;
    updateProfile.mutate({ email: email.trim() });
  };

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
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-end flex-wrap gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setLocation("/home")}
          data-testid="button-close-account"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-xs">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="input-email"
            />
          </div>
          <Button
            onClick={handleSaveProfile}
            disabled={updateProfile.isPending}
            data-testid="button-save-profile"
          >
            {updateProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Change Password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword" className="text-xs">Current Password</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              data-testid="input-current-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword" className="text-xs">New Password</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              data-testid="input-new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword" className="text-xs">Confirm New Password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              data-testid="input-confirm-password"
            />
          </div>
          <Button
            onClick={handleChangePassword}
            disabled={changePassword.isPending || !currentPassword || !newPassword || !confirmPassword}
            data-testid="button-change-password"
          >
            {changePassword.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Change Password
          </Button>
        </CardContent>
      </Card>

      <DisplaySection />

      <TimezoneSection />

      <Card>
        <CardContent className="pt-6">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-destructive"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            data-testid="button-logout"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timezone (moved from Settings/Integrations)
// ---------------------------------------------------------------------------

const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Phoenix", "America/Toronto",
  "America/Vancouver", "America/Mexico_City", "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Europe/Amsterdam", "Europe/Madrid", "Europe/Rome", "Europe/Moscow",
  "Europe/Istanbul", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok", "Asia/Shanghai",
  "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Asia/Hong_Kong",
  "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland",
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos",
];

function getAllTimezones(): string[] {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[];
  } catch {
    return COMMON_TIMEZONES;
  }
}

function formatTimezoneOffset(tz: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    return offsetPart?.value || "";
  } catch {
    return "";
  }
}

function DisplaySection() {
  const { scale, setScale, persistScale, DEFAULT_SCALE } = useUiScale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Monitor className="h-4 w-4" />
          Display
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">UI Scale</Label>
            <span className="text-xs text-muted-foreground font-mono" data-testid="text-ui-scale-value">{scale}%</span>
          </div>
          <input
            type="range"
            min={90}
            max={120}
            step={1}
            value={scale}
            onChange={(e) => setScale(parseInt(e.target.value, 10))}
            onMouseUp={(e) => persistScale(parseInt((e.target as HTMLInputElement).value, 10))}
            onTouchEnd={(e) => persistScale(parseInt((e.target as HTMLInputElement).value, 10))}
            className="w-full accent-primary"
            data-testid="input-ui-scale"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>90%</span>
            <button
              className="hover:text-foreground transition-colors"
              onClick={() => { setScale(DEFAULT_SCALE); persistScale(DEFAULT_SCALE); }}
              data-testid="button-reset-ui-scale"
            >
              Default ({DEFAULT_SCALE}%)
            </button>
            <span>120%</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Scales all text, spacing, and buttons. Syncs across devices.
        </p>
      </CardContent>
    </Card>
  );
}

function TimezoneSection() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading } = useQuery<{ timezone: string; localTime: string }>({
    queryKey: ["/api/settings/timezone"],
  });

  const mutation = useMutation({
    mutationFn: async (timezone: string) => {
      const res = await apiRequest("PUT", "/api/settings/timezone", { timezone });
      return res.json();
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/timezone"] });
      toast({ title: "Timezone updated", description: `Set to ${result.timezone}. Agent restarting to apply.` });
    },
    onError: (err: Error) => {
      log.error("timezone update failed:", err);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const allTimezones = useMemo(() => getAllTimezones(), []);

  const filteredTimezones = useMemo(() => {
    const source = showAll ? allTimezones : COMMON_TIMEZONES;
    if (!search.trim()) return source;
    const q = search.toLowerCase();
    return source.filter((tz) => tz.toLowerCase().includes(q));
  }, [search, showAll, allTimezones]);

  const currentTimezone = data?.timezone || "America/New_York";

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Timezone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" data-testid="text-timezone-title">
          <Clock className="h-5 w-5" />
          Timezone
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>Current timezone</Label>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-medium px-2 py-0.5" data-testid="badge-current-timezone">
              {currentTimezone}
            </Badge>
            <span className="text-sm text-muted-foreground" data-testid="text-local-time">
              {data?.localTime || ""}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Change timezone</Label>
          <Input
            placeholder="Search timezones..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-timezone-search"
          />
          <div className="flex items-center gap-2">
            <Button
              variant={showAll ? "default" : "outline"}
              size="sm"
              onClick={() => setShowAll(!showAll)}
              data-testid="button-toggle-all-timezones"
            >
              {showAll ? "Common" : "Show all"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {filteredTimezones.length} timezone{filteredTimezones.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto border rounded-md">
            {filteredTimezones.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">No matching timezones</div>
            ) : (
              filteredTimezones.map((tz) => {
                const isActive = tz === currentTimezone;
                const offset = formatTimezoneOffset(tz);
                return (
                  <button
                    key={tz}
                    onClick={() => {
                      if (!isActive) mutation.mutate(tz);
                    }}
                    disabled={mutation.isPending}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover-elevate",
                      isActive && "bg-accent/50",
                    )}
                    data-testid={`button-timezone-${tz.replace(/\//g, "-")}`}
                  >
                    <span className="flex items-center gap-2">
                      {isActive && <Check className="h-3.5 w-3.5 text-primary" />}
                      <span className={isActive ? "font-medium" : ""}>{tz.replace(/_/g, " ")}</span>
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">{offset}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          This timezone is used by the agent, voice sessions, and all dashboard displays.
        </p>
      </CardContent>
    </Card>
  );
}
