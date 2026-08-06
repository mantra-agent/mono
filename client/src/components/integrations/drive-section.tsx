import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileText, Folder, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
import { apiRequest } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";

const log = createLogger("DriveSection");

interface DriveResource {
  id: string;
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  webUrl: string | null;
}

interface PickerDocument {
  id: string;
  name: string;
  mimeType?: string;
  url?: string;
  type?: string;
}

interface GooglePickerDocsView {
  setIncludeFolders: (include: boolean) => GooglePickerDocsView;
  setSelectFolderEnabled: (enabled: boolean) => GooglePickerDocsView;
}

interface GooglePickerBuilder {
  addView: (view: unknown) => GooglePickerBuilder;
  enableFeature: (feature: string) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  setCallback: (callback: (data: { action: string; docs?: PickerDocument[] }) => void) => GooglePickerBuilder;
  setSelectableMimeTypes: (types: string) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

let pickerLoad: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (pickerLoad) return pickerLoad;
  pickerLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://apis.google.com/js/api.js"]');
    const onReady = () => {
      const gapi = (window as unknown as {
        gapi?: { load: (name: string, opts: { callback: () => void; onerror: () => void }) => void };
      }).gapi;
      if (!gapi) {
        reject(new Error("Google API script failed to load"));
        return;
      }
      gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker failed to load")) });
    };

    if (existing) {
      onReady();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = onReady;
    script.onerror = () => reject(new Error("Google API script failed to load"));
    document.head.appendChild(script);
  }).catch((error) => {
    pickerLoad = null;
    throw error;
  });
  return pickerLoad;
}

function openGooglePicker(options: {
  accessToken: string;
  developerKey: string;
  appId: string;
  onPicked: (documents: PickerDocument[]) => void;
  onClosed: () => void;
}) {
  const google = (window as unknown as {
    google?: {
      picker: {
        PickerBuilder: new () => GooglePickerBuilder;
        ViewId: { DOCS: string };
        Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
        DocsView: new (viewId: string) => GooglePickerDocsView;
        Action: { PICKED: string; CANCEL: string };
      };
    };
  }).google;
  if (!google?.picker) throw new Error("Google Picker not loaded");

  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true);
  const picker = new google.picker.PickerBuilder()
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
    .setSelectableMimeTypes("application/vnd.google-apps.document,application/vnd.google-apps.spreadsheet,application/vnd.google-apps.presentation,application/vnd.google-apps.folder,application/pdf,text/plain,text/markdown")
    .setOAuthToken(options.accessToken)
    .setDeveloperKey(options.developerKey)
    .setAppId(options.appId)
    .setCallback((data) => {
      if (data.action === google.picker.Action.PICKED) {
        options.onPicked(data.docs ?? []);
        options.onClosed();
      } else if (data.action === google.picker.Action.CANCEL) {
        options.onClosed();
      }
    })
    .build();
  picker.setVisible(true);
}

export function DriveSection({
  vaultId,
  connectedAccountId,
  drivePickerConfigured,
  hasDriveScope,
  onReconnect,
}: {
  vaultId?: string;
  connectedAccountId?: string;
  drivePickerConfigured: boolean;
  hasDriveScope: boolean;
  onReconnect: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);

  const resourcesQuery = useQuery<{ resources: DriveResource[] }>({
    queryKey: ["/api/drive/resources", vaultId, connectedAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({ vaultId: vaultId!, connectedAccountId: connectedAccountId! });
      const response = await apiRequest("GET", `/api/drive/resources?${params.toString()}`);
      return response.json();
    },
    enabled: Boolean(vaultId && connectedAccountId && drivePickerConfigured && hasDriveScope),
  });

  const bindMutation = useMutation({
    mutationFn: async (documents: PickerDocument[]) => {
      if (!vaultId || !connectedAccountId) throw new Error("Drive connection context is unavailable");
      await Promise.all(documents.map(async (document) => {
        const response = await apiRequest("POST", "/api/drive/resources", {
          vaultId,
          connectedAccountId,
          provider: "google",
          providerFileId: document.id,
          name: document.name,
          mimeType: document.mimeType ?? null,
          resourceType: document.type === "folder" || document.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
          webUrl: document.url ?? null,
          accessMode: "inherited",
        });
        return response.json();
      }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/drive/resources", vaultId] }),
    onError: (error) => log.error("Drive bind failed", { error: String(error) }),
  });

  const unbindMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/drive/resources/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/drive/resources", vaultId] }),
    onError: (error) => log.error("Drive unbind failed", { error: String(error) }),
  });

  const handlePick = useCallback(async () => {
    if (!connectedAccountId) return;
    setPicking(true);
    try {
      await loadPicker();
      const response = await apiRequest("POST", "/api/drive/picker-token", { connectedAccountId });
      const payload = await response.json() as {
        accessToken?: string;
        developerKey?: string;
        apiKey?: string;
        appId?: string;
        configured?: boolean;
      };
      const developerKey = payload.developerKey || payload.apiKey;
      if (!payload.accessToken || !developerKey || !payload.appId) {
        throw new Error(payload.configured === false
          ? "Drive picker isn't configured on this deployment"
          : "Drive picker token response was incomplete");
      }
      openGooglePicker({
        accessToken: payload.accessToken,
        developerKey,
        appId: payload.appId,
        onPicked: (documents) => bindMutation.mutate(documents),
        onClosed: () => setPicking(false),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log.error("Drive picker failed", { error: String(error) });
      toast({
        title: "Couldn't open Google Drive",
        description: message,
        variant: "destructive",
      });
      setPicking(false);
    }
  }, [bindMutation, connectedAccountId, toast]);

  if (!drivePickerConfigured) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-drive-picker-not-configured">
        Drive picker isn't configured on this deployment.
      </p>
    );
  }

  if (!connectedAccountId) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-drive-account-required">
        Connect a Google account to choose Drive files.
      </p>
    );
  }

  if (!hasDriveScope) {
    return (
      <div className="flex items-center justify-between gap-3 px-2 py-1.5">
        <p className="text-sm text-muted-foreground">Reconnect Google to grant read-only folder access. Then reselect any folders you want to bind.</p>
        <Button variant="outline" size="sm" onClick={onReconnect} data-testid="button-drive-reconnect-google">
          Reconnect Google
        </Button>
      </div>
    );
  }

  if (!vaultId) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-drive-vault-required">
        Create or join a Vault before choosing Drive files.
      </p>
    );
  }

  const resources = resourcesQuery.data?.resources ?? [];

  return (
    <div className="space-y-1 py-1" data-testid="drive-integration-section">
      <button
        type="button"
        className={HIERARCHY_PRIMARY_ACTION_CLASS}
        onClick={handlePick}
        disabled={picking || bindMutation.isPending}
        data-testid="button-drive-choose-files"
      >
        {picking || bindMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        <span>{picking ? "Picking…" : "Choose Files"}</span>
      </button>

      {resourcesQuery.isLoading ? (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading Drive files…
        </div>
      ) : resources.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground" data-testid="text-drive-empty">
          No files included.
        </p>
      ) : (
        <ul className="divide-y divide-border/20" data-testid="list-drive-resources">
          {resources.map((resource) => {
            const Icon = resource.resourceType === "folder" ? Folder : FileText;
            return (
              <li key={resource.id} className="flex min-h-10 items-center gap-2 px-2 py-1.5">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <a
                  className="min-w-0 flex-1 truncate text-sm hover:text-cta"
                  href={resource.webUrl ?? `https://drive.google.com/open?id=${encodeURIComponent(resource.providerFileId)}`}
                  target="_blank"
                  rel="noreferrer"
                  title={resource.name}
                  data-testid={`link-drive-open-${resource.id}`}
                >
                  {resource.name}
                </a>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => unbindMutation.mutate(resource.id)} disabled={unbindMutation.isPending} aria-label={`Remove ${resource.name}`} data-testid={`button-drive-remove-${resource.id}`}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
