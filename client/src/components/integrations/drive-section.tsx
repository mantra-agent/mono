import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Folder, HardDrive, Loader2, Plus } from "lucide-react";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
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
}: {
  vaultId?: string;
  connectedAccountId?: string;
  drivePickerConfigured: boolean;
  hasDriveScope: boolean;
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

  const resources = resourcesQuery.data?.resources ?? [];
  const canBrowse = Boolean(drivePickerConfigured && connectedAccountId && hasDriveScope && vaultId);
  const driveStatus = !hasDriveScope
    ? "Reconnect to enable"
    : !drivePickerConfigured
      ? "Picker not configured"
      : !connectedAccountId
        ? "Account required"
        : !vaultId
          ? "Vault required"
          : resourcesQuery.isLoading
            ? "Loading…"
            : resources.length === 0
              ? "No files included"
              : `${resources.length} included`;

  return (
    <div data-testid="drive-integration-section">
      <ProfileTreeRow
        label={<span>Drive</span>}
        icon={<HardDrive className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-google-drive"
      >
        <span className={!hasDriveScope ? "text-muted-foreground" : undefined}>{driveStatus}</span>
      </ProfileTreeRow>

      {canBrowse && resourcesQuery.isLoading ? (
        <HierarchyTreeRow continues connectorAnchor="first-row-center">
          <div className="flex min-h-10 items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading Drive files…
          </div>
        </HierarchyTreeRow>
      ) : null}

      {canBrowse
        ? resources.map((resource) => {
            const Icon = resource.resourceType === "folder" ? Folder : FileText;
            return (
              <HierarchyTreeRow
                key={resource.id}
                continues
                connectorAnchor="first-row-center"
              >
                <div className="flex min-h-10 items-center gap-2 px-2 py-1.5" data-testid={`row-drive-resource-${resource.id}`}>
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
                </div>
              </HierarchyTreeRow>
            );
          })
        : null}

      {canBrowse ? (
        <HierarchyTreeRow continues={false} connectorAnchor="first-row-center">
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
        </HierarchyTreeRow>
      ) : null}
    </div>
  );
}
