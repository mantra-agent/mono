import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, Loader2, MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useVaults } from "@/hooks/use-vaults";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { HIERARCHY_PRIMARY_ACTION_CLASS, HIERARCHY_TREE_STACK_CLASS } from "@/components/hierarchy-section-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const SLACK_TEAM_ID = /^T[A-Z0-9]{1,31}$/;
const SLACK_APP_ID = /^A[A-Z0-9]{1,31}$/;
const SLACK_USER_ID = /^U[A-Z0-9]{1,31}$/;
const SLACK_CHANNEL_ID = /^C[A-Z0-9]{1,31}$/;

interface SlackConnection {
  id: number;
  provider: string;
  label: string;
  status: string;
  hasCredential?: boolean;
}

interface SlackMapping {
  slackUserId: string;
  mantraUserId: string;
  active: boolean;
}

interface SlackInstallation {
  id: string;
  platformEnvironmentId: number;
  providerConnectionId: number;
  teamId: string;
  apiAppId: string;
  botUserId: string;
  vaultId: string;
  allowedChannelIds: string[];
  allowedChannelName?: string | null;
  enabled: boolean;
  status: string;
  mappings?: SlackMapping[];
}

interface PlatformListItem {
  id: number;
  name: string;
  products?: Array<{
    id: number;
    name: string;
    environments?: Array<{ id: number; name: string }>;
  }>;
}

interface SlackModStatus {
  mods: Array<{ key: string; status: string }>;
  canManage: boolean;
}

function parseApiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Request failed";
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // Keep the raw transport error when the body is not JSON.
    }
  }
  return raw.replace(/^\d+:\s*/, "");
}

export function SlackDetail() {
  const { toast } = useToast();
  const { user, hasPermission } = useAuth();
  const { vaults, activeVaultId } = useVaults();
  const canManage = hasPermission("mods:manage");

  const modsQuery = useQuery<SlackModStatus>({
    queryKey: ["/api/mods"],
    enabled: canManage,
  });
  const slackMod = (modsQuery.data?.mods || []).find((mod) => mod.key === "slack");
  const slackModActive = slackMod?.status === "enabled";

  const connectionsQuery = useQuery<SlackConnection[]>({
    queryKey: ["/api/provider-connections"],
    enabled: canManage,
  });
  const installationsQuery = useQuery<SlackInstallation[]>({
    queryKey: ["/api/slack/installations"],
    enabled: canManage && slackModActive,
  });
  const platformsQuery = useQuery<PlatformListItem[]>({
    queryKey: ["/api/platforms"],
    enabled: canManage,
  });

  const slackConnections = (connectionsQuery.data || []).filter((connection) => connection.provider === "slack");
  const installations = installationsQuery.data || [];
  const liveVaults = vaults.filter((vault) => !vault.isArchived);
  const environments = useMemo(() => {
    return (platformsQuery.data || []).flatMap((platform) =>
      (platform.products || []).flatMap((product) =>
        (product.environments || []).map((environment) => ({
          id: environment.id,
          label: `${platform.name} / ${product.name} / ${environment.name}`,
        })),
      ),
    );
  }, [platformsQuery.data]);

  const [connectionOpen, setConnectionOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SlackConnection | null>(null);
  const [connectionLabel, setConnectionLabel] = useState("Mantra Slack");
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");

  const [installationOpen, setInstallationOpen] = useState(false);
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [platformEnvironmentId, setPlatformEnvironmentId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [apiAppId, setApiAppId] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");

  const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>({});
  const [channelNameDrafts, setChannelNameDrafts] = useState<Record<string, string>>({});

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/mods"] });
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    queryClient.invalidateQueries({ queryKey: ["/api/slack/installations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/setup/secrets-status"] });
  };

  const installMod = useMutation({
    mutationFn: async () => {
      const action = slackMod?.status === "error" ? "reinstall" : "install";
      await apiRequest("POST", `/api/mods/slack/${action}`);
    },
    onSuccess: () => {
      toast({ title: "Slack Mod installed" });
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Slack Mod install failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  const resetConnectionForm = () => {
    setConnectionOpen(false);
    setEditingConnection(null);
    setConnectionLabel("Mantra Slack");
    setAppToken("");
    setBotToken("");
  };

  const openConnectionForm = (connection?: SlackConnection) => {
    setEditingConnection(connection || null);
    setConnectionLabel(connection?.label || "Mantra Slack");
    setAppToken("");
    setBotToken("");
    setConnectionOpen(true);
  };

  const resetInstallationForm = () => {
    setInstallationOpen(false);
    setProviderConnectionId(slackConnections[0] ? String(slackConnections[0].id) : "");
    setPlatformEnvironmentId(environments[0] ? String(environments[0].id) : "");
    setVaultId(activeVaultId || liveVaults[0]?.id || "");
    setTeamId("");
    setApiAppId("");
    setBotUserId("");
    setChannelId("");
    setChannelName("");
  };

  const saveConnection = useMutation({
    mutationFn: async () => {
      const label = connectionLabel.trim();
      const nextApp = appToken.trim();
      const nextBot = botToken.trim();
      if (!label) throw new Error("Label required");
      if (!editingConnection && (!nextApp || !nextBot)) throw new Error("Both Slack tokens are required");
      if (nextApp && !nextApp.startsWith("xapp-")) throw new Error("App-level token must start with xapp-");
      if (nextBot && !nextBot.startsWith("xoxb-")) throw new Error("Bot token must start with xoxb-");
      if ((nextApp && !nextBot) || (nextBot && !nextApp)) throw new Error("Enter both tokens together to rotate credentials");
      const body: Record<string, string> = {
        provider: "slack",
        label,
        accountType: "slack",
      };
      if (nextApp && nextBot) body.credential = JSON.stringify({ appToken: nextApp, botToken: nextBot });
      const res = editingConnection
        ? await apiRequest("PUT", `/api/provider-connections/${editingConnection.id}`, body)
        : await apiRequest("POST", "/api/provider-connections", body);
      return res.json() as Promise<SlackConnection>;
    },
    onSuccess: () => {
      toast({ title: editingConnection ? "Slack connection updated" : "Slack connection saved" });
      resetConnectionForm();
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Slack connection failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  const deleteConnection = useMutation({
    mutationFn: async (connection: SlackConnection) => {
      if (installations.some((installation) => installation.providerConnectionId === connection.id)) {
        throw new Error("Disable and remove installations that use this connection first.");
      }
      await apiRequest("DELETE", `/api/provider-connections/${connection.id}`);
    },
    onSuccess: () => {
      toast({ title: "Slack connection deleted" });
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Delete blocked", description: parseApiError(error), variant: "destructive" });
    },
  });

  const createInstall = useMutation({
    mutationFn: async () => {
      const ids = [teamId, apiAppId, botUserId, channelId].map((value) => value.trim().toUpperCase());
      if (!SLACK_TEAM_ID.test(ids[0]) || !SLACK_APP_ID.test(ids[1]) || !SLACK_USER_ID.test(ids[2]) || !SLACK_CHANNEL_ID.test(ids[3])) {
        throw new Error("Team, App, Bot, and Channel IDs must look like T… / A… / U… / C…");
      }
      const environmentId = Number.parseInt(platformEnvironmentId, 10);
      const connectionId = Number.parseInt(providerConnectionId, 10);
      if (!Number.isInteger(environmentId) || environmentId <= 0) throw new Error("Choose a Platform Environment");
      if (!Number.isInteger(connectionId) || connectionId <= 0) throw new Error("Choose a Slack connection");
      if (!vaultId) throw new Error("Choose a Vault");
      const res = await apiRequest("POST", "/api/slack/installations", {
        platformEnvironmentId: environmentId,
        providerConnectionId: connectionId,
        teamId: ids[0],
        apiAppId: ids[1],
        botUserId: ids[2],
        vaultId,
        allowedChannelId: ids[3],
        ...(channelName.trim() ? { allowedChannelName: channelName.trim() } : {}),
      });
      return res.json() as Promise<SlackInstallation>;
    },
    onSuccess: () => {
      toast({ title: "Slack installation created", description: "It stays disabled until you add a mapping and enable it." });
      resetInstallationForm();
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Installation failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  const saveChannelName = useMutation({
    mutationFn: async (installation: SlackInstallation) => {
      const allowedChannelName = (channelNameDrafts[installation.id] || installation.allowedChannelName || "").trim();
      if (!/^#?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(allowedChannelName)) {
        throw new Error("Channel name looks like eng or #eng");
      }
      const res = await apiRequest("PUT", `/api/slack/installations/${installation.id}/channel-name`, { allowedChannelName });
      return res.json() as Promise<SlackInstallation>;
    },
    onSuccess: () => {
      toast({ title: "Channel name saved" });
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Channel name failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  const saveMapping = useMutation({
    mutationFn: async (installation: SlackInstallation) => {
      const slackUserId = (mappingDrafts[installation.id] || "").trim().toUpperCase();
      if (!SLACK_USER_ID.test(slackUserId)) throw new Error("Slack User ID must look like U…");
      if (!user?.id) throw new Error("Sign in before mapping a Slack user");
      await apiRequest("PUT", `/api/slack/installations/${installation.id}/mappings`, {
        slackUserId,
        mantraUserId: user.id,
      });
    },
    onSuccess: (_data, installation) => {
      toast({ title: "Slack user mapped" });
      setMappingDrafts((current) => ({ ...current, [installation.id]: "" }));
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Mapping failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  const setEnabled = useMutation({
    mutationFn: async ({ installation, enabled }: { installation: SlackInstallation; enabled: boolean }) => {
      if (enabled && (installation.mappings || []).filter((mapping) => mapping.active).length === 0) {
        throw new Error("Map at least one Slack user before enabling");
      }
      const res = await apiRequest("PUT", `/api/slack/installations/${installation.id}/enabled`, { enabled });
      return res.json() as Promise<SlackInstallation>;
    },
    onSuccess: (installation) => {
      toast({ title: installation.enabled ? "Slack enabled" : "Slack disabled" });
      refresh();
    },
    onError: (error: unknown) => {
      toast({ title: "Kill switch failed", description: parseApiError(error), variant: "destructive" });
    },
  });

  if (!canManage) {
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">Slack setup requires mods:manage.</p>;
  }

  if (modsQuery.isLoading) {
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">Checking Slack Mod…</p>;
  }

  if (!slackModActive) {
    return (
      <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="slack-mod-inactive">
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          Slack APIs stay closed until the Slack Mod is installed for this account.
        </p>
        <button
          type="button"
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          onClick={() => installMod.mutate()}
          disabled={installMod.isPending}
          data-testid="button-slack-install-mod"
        >
          {installMod.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{slackMod?.status === "error" ? "Reinstall Slack" : "Install Slack"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="slack-detail">
      <ProfileDetailSection title="Connections" defaultOpen testId="slack-connections">
        <button
          type="button"
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          onClick={() => openConnectionForm()}
          data-testid="button-slack-add-connection"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">New connection</span>
        </button>
        {slackConnections.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No Slack connections yet. Tokens are stored encrypted and never displayed.</p>
        ) : slackConnections.map((connection, index) => (
          <HierarchyTreeRow key={connection.id} continues={index < slackConnections.length - 1} connectorAnchor="first-row-center">
            <ProfileTreeRow
              label={connection.label}
              icon={<CircleCheck className={cn("h-3.5 w-3.5", connection.status === "active" ? "text-active" : "text-muted-foreground")} />}
              hasValue
              showEmpty
              testId={`slack-connection-${connection.id}`}
              menuVisibility="hover"
              menuContent={(
                <>
                  <DropdownMenuItem onClick={() => openConnectionForm(connection)} data-testid={`button-slack-edit-connection-${connection.id}`}>
                    <Pencil className="mr-2 h-4 w-4" /> Rotate tokens
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete Slack connection ${connection.label}?`)) deleteConnection.mutate(connection);
                    }}
                    data-testid={`button-slack-delete-connection-${connection.id}`}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            >
              {connection.status}
            </ProfileTreeRow>
          </HierarchyTreeRow>
        ))}
      </ProfileDetailSection>

      <ProfileDetailSection title="Installation" defaultOpen testId="slack-installations">
        <button
          type="button"
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          onClick={() => {
            setProviderConnectionId(slackConnections[0] ? String(slackConnections[0].id) : "");
            setPlatformEnvironmentId(environments[0] ? String(environments[0].id) : "");
            setVaultId(activeVaultId || liveVaults[0]?.id || "");
            setInstallationOpen(true);
          }}
          disabled={slackConnections.length === 0}
          data-testid="button-slack-add-installation"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">New installation</span>
        </button>
        {installations.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No Slack installation yet.</p>
        ) : installations.map((installation, index) => {
          const mappings = installation.mappings || [];
          const environmentLabel = environments.find((environment) => environment.id === installation.platformEnvironmentId)?.label
            || `Environment ${installation.platformEnvironmentId}`;
          const vaultName = liveVaults.find((vault) => vault.id === installation.vaultId)?.name || installation.vaultId;
          return (
            <HierarchyTreeRow key={installation.id} continues={index < installations.length - 1} connectorAnchor="first-row-center">
              <ProfileTreeRow
                label={`${installation.teamId} · ${installation.apiAppId}`}
                icon={<MessageSquare className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                defaultOpen
                testId={`slack-installation-${installation.id}`}
                expandedContentClassName="min-w-0 space-y-3"
                actionContent={(
                  <Switch
                    checked={installation.enabled}
                    disabled={setEnabled.isPending}
                    onCheckedChange={(enabled) => setEnabled.mutate({ installation, enabled })}
                    aria-label={installation.enabled ? "Disable Slack" : "Enable Slack"}
                    data-testid={`switch-slack-enabled-${installation.id}`}
                  />
                )}
                expandedContent={(
                  <>
                    <p className="text-sm text-muted-foreground">
                      {installation.enabled ? "Enabled" : "Disabled"} · {installation.status} · {environmentLabel} · {vaultName}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground break-all">
                      bot {installation.botUserId}
                      {installation.allowedChannelIds[0] ? ` · ${installation.allowedChannelName || installation.allowedChannelIds[0]}` : " · no channel"}
                    </p>
                    <div className="space-y-1">
                      {mappings.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-muted-foreground">No mappings yet.</p>
                      ) : mappings.map((mapping) => (
                        <p key={`${mapping.slackUserId}:${mapping.mantraUserId}`} className="px-2 py-1.5 font-mono text-xs">
                          {mapping.slackUserId} → {mapping.mantraUserId}{mapping.active ? "" : " · inactive"}
                        </p>
                      ))}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Label htmlFor={`slack-channel-name-${installation.id}`}>Channel name</Label>
                        <Input
                          id={`slack-channel-name-${installation.id}`}
                          value={channelNameDrafts[installation.id] ?? installation.allowedChannelName ?? ""}
                          onChange={(event) => setChannelNameDrafts((current) => ({ ...current, [installation.id]: event.target.value }))}
                          placeholder="#eng"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                          data-testid={`input-slack-channel-name-${installation.id}`}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => saveChannelName.mutate(installation)}
                        disabled={saveChannelName.isPending}
                        data-testid={`button-slack-channel-name-${installation.id}`}
                      >
                        Save name
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1 space-y-2">
                        <Label htmlFor={`slack-user-${installation.id}`}>Your Slack User ID</Label>
                        <Input
                          id={`slack-user-${installation.id}`}
                          value={mappingDrafts[installation.id] || ""}
                          onChange={(event) => setMappingDrafts((current) => ({ ...current, [installation.id]: event.target.value }))}
                          placeholder="U…"
                          autoComplete="off"
                          spellCheck={false}
                          className="font-mono text-xs"
                          data-testid={`input-slack-user-${installation.id}`}
                        />
                      </div>
                      <Button
                        type="button"
                        onClick={() => saveMapping.mutate(installation)}
                        disabled={saveMapping.isPending}
                        data-testid={`button-slack-map-${installation.id}`}
                      >
                        {saveMapping.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Map to me"}
                      </Button>
                    </div>
                  </>
                )}
              >
                {installation.enabled ? "on" : "off"}
              </ProfileTreeRow>
            </HierarchyTreeRow>
          );
        })}
      </ProfileDetailSection>

      <Dialog open={connectionOpen} onOpenChange={(open) => { if (!open) resetConnectionForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingConnection ? "Rotate Slack tokens" : "New Slack connection"}</DialogTitle>
            <DialogDescription>
              Paste the app-level token and bot token here only. They are encrypted on save and never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="slack-connection-label">Label</Label>
              <Input
                id="slack-connection-label"
                value={connectionLabel}
                onChange={(event) => setConnectionLabel(event.target.value)}
                data-testid="input-slack-connection-label"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slack-app-token">App-level token</Label>
              <Input
                id="slack-app-token"
                type="password"
                value={appToken}
                onChange={(event) => setAppToken(event.target.value)}
                placeholder="xapp-…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                data-testid="input-slack-app-token"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slack-bot-token">Bot token</Label>
              <Input
                id="slack-bot-token"
                type="password"
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder="xoxb-…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                data-testid="input-slack-bot-token"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetConnectionForm}>Cancel</Button>
            <Button
              type="button"
              onClick={() => saveConnection.mutate()}
              disabled={saveConnection.isPending}
              data-testid="button-slack-connection-save"
            >
              {saveConnection.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Save connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={installationOpen} onOpenChange={(open) => { if (!open) resetInstallationForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Slack installation</DialogTitle>
            <DialogDescription>
              IDs only. Tokens stay on the connection. The installation is created disabled.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Connection</Label>
              <Select value={providerConnectionId} onValueChange={setProviderConnectionId}>
                <SelectTrigger data-testid="select-slack-connection"><SelectValue placeholder="Choose connection" /></SelectTrigger>
                <SelectContent>
                  {slackConnections.map((connection) => (
                    <SelectItem key={connection.id} value={String(connection.id)}>{connection.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Environment</Label>
              {environments.length > 0 ? (
                <Select value={platformEnvironmentId} onValueChange={setPlatformEnvironmentId}>
                  <SelectTrigger data-testid="select-slack-environment"><SelectValue placeholder="Choose environment" /></SelectTrigger>
                  <SelectContent>
                    {environments.map((environment) => (
                      <SelectItem key={environment.id} value={String(environment.id)}>{environment.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={platformEnvironmentId}
                  onChange={(event) => setPlatformEnvironmentId(event.target.value)}
                  placeholder="Platform Environment ID"
                  inputMode="numeric"
                  data-testid="input-slack-environment"
                />
              )}
            </div>
            <div className="space-y-2">
              <Label>Vault</Label>
              <Select value={vaultId} onValueChange={setVaultId}>
                <SelectTrigger data-testid="select-slack-vault"><SelectValue placeholder="Choose vault" /></SelectTrigger>
                <SelectContent>
                  {liveVaults.map((vault) => (
                    <SelectItem key={vault.id} value={vault.id}>{vault.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="slack-team-id">Team ID</Label>
                <Input id="slack-team-id" value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="T…" className="font-mono text-xs" autoComplete="off" spellCheck={false} data-testid="input-slack-team-id" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slack-app-id">App ID</Label>
                <Input id="slack-app-id" value={apiAppId} onChange={(event) => setApiAppId(event.target.value)} placeholder="A…" className="font-mono text-xs" autoComplete="off" spellCheck={false} data-testid="input-slack-app-id" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slack-bot-id">Bot User ID</Label>
                <Input id="slack-bot-id" value={botUserId} onChange={(event) => setBotUserId(event.target.value)} placeholder="U…" className="font-mono text-xs" autoComplete="off" spellCheck={false} data-testid="input-slack-bot-id" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slack-channel-id">Channel ID</Label>
                <Input id="slack-channel-id" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="C…" className="font-mono text-xs" autoComplete="off" spellCheck={false} data-testid="input-slack-channel-id" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slack-channel-name">Channel name</Label>
                <Input id="slack-channel-name" value={channelName} onChange={(event) => setChannelName(event.target.value)} placeholder="#eng" className="font-mono text-xs" autoComplete="off" spellCheck={false} data-testid="input-slack-channel-name" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={resetInstallationForm}>Cancel</Button>
            <Button type="button" onClick={() => createInstall.mutate()} disabled={createInstall.isPending} data-testid="button-slack-installation-save">
              {createInstall.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Create disabled
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
