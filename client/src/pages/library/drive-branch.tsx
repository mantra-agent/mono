import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  ExternalLink,
  X,
  HardDrive,
  Plus,
  Share2,
  ChevronRight,
  ChevronDown,
  FileText,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { ShareSheet } from "@/components/sharing/share-sheet";

const log = createLogger("DriveBranch");

interface DriveResource {
  id: string;
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
}

interface FilesChild {
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
  driveResourceId: string | null;
  viaFolderBind: boolean;
}

interface PickerToken {
  configured: boolean;
  accessToken?: string;
  apiKey?: string;
  appId?: string | null;
}

interface ConnectedAccountRow {
  id: number;
  accountId: string;
  provider: string;
  email?: string | null;
  label?: string | null;
}

// Lazily inject the Google Picker script once. Resolves when window.google.picker is ready.
let pickerLoad: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  if (pickerLoad) return pickerLoad;
  pickerLoad = new Promise<void>((resolve, reject) => {
    const w = window as unknown as { gapi?: { load: (m: string, cb: () => void) => void } };
    const finish = () => w.gapi!.load("picker", () => resolve());
    if (w.gapi) return finish();
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => finish();
    script.onerror = () => {
      pickerLoad = null;
      reject(new Error("Failed to load Google API script"));
    };
    document.head.appendChild(script);
  });
  return pickerLoad;
}

type GoogleDoc = {
  id: string;
  name: string;
  mimeType?: string;
  iconUrl?: string;
  url?: string;
};

type GooglePickerData = {
  action: string;
  docs?: GoogleDoc[];
};

type GooglePickerBuilder = {
  addView: (view: unknown) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  setCallback: (cb: (data: GooglePickerData) => void) => GooglePickerBuilder;
  enableFeature: (feature: string) => GooglePickerBuilder;
  setSelectableMimeTypes: (types: string) => GooglePickerBuilder;
  build: () => { setVisible: (v: boolean) => void };
};

function openGooglePicker(opts: {
  accessToken: string;
  apiKey: string;
  appId?: string | null;
  onPicked: (docs: GoogleDoc[]) => void;
}): void {
  const g = (window as unknown as {
    google?: {
      picker: {
        PickerBuilder: new () => GooglePickerBuilder;
        ViewId: { DOCS: string };
        Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
        Action: { PICKED: string };
        DocsView: new (viewId: string) => {
          setIncludeFolders: (v: boolean) => unknown;
          setSelectFolderEnabled: (v: boolean) => unknown;
        };
      };
    };
  }).google;
  if (!g?.picker) throw new Error("Google Picker not loaded");

  const view = new g.picker.DocsView(g.picker.ViewId.DOCS);
  (view as { setIncludeFolders: (v: boolean) => void }).setIncludeFolders(true);
  (view as { setSelectFolderEnabled: (v: boolean) => void }).setSelectFolderEnabled(true);

  let builder = new g.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(opts.accessToken)
    .setDeveloperKey(opts.apiKey)
    .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
    .enableFeature(g.picker.Feature.SUPPORT_DRIVES)
    .setCallback((data: GooglePickerData) => {
      if (data.action === g.picker.Action.PICKED && data.docs?.length) {
        opts.onPicked(data.docs);
      }
    });
  if (opts.appId) builder = builder.setAppId(opts.appId);
  builder.build().setVisible(true);
}

function resourceIcon(r: { iconUrl: string | null; resourceType: string }) {
  if (r.iconUrl) {
    return <img src={r.iconUrl} alt="" className="h-4 w-4 shrink-0" />;
  }
  return r.resourceType === "folder" ? (
    <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
  );
}

function FolderChildren({
  vaultId,
  driveResourceId,
  provider,
  providerFileId,
  depth,
  searchQuery,
}: {
  vaultId: string;
  driveResourceId?: string;
  provider?: "google" | "box" | "mantra";
  providerFileId?: string;
  depth: number;
  searchQuery: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = searchQuery.trim().toLowerCase();

  const childrenQuery = useQuery<{ children: FilesChild[]; nextPageToken: string | null }>({
    queryKey: [
      "/api/files/children",
      vaultId,
      driveResourceId ?? null,
      provider ?? null,
      providerFileId ?? null,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ vaultId });
      if (driveResourceId) params.set("driveResourceId", driveResourceId);
      if (provider) params.set("provider", provider);
      if (providerFileId) params.set("providerFileId", providerFileId);
      const res = await apiRequest("GET", `/api/files/children?${params.toString()}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  if (childrenQuery.isLoading) {
    return (
      <div
        className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
        style={{ paddingLeft: 12 + depth * 12 }}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> Loading…
      </div>
    );
  }
  if (childrenQuery.isError) {
    return (
      <div className="py-1 text-xs text-destructive" style={{ paddingLeft: 12 + depth * 12 }}>
        {(childrenQuery.error as Error)?.message || "Failed to list folder"}
      </div>
    );
  }

  const children = (childrenQuery.data?.children ?? []).filter(
    (c) => !q || c.name.toLowerCase().includes(q),
  );
  if (children.length === 0) {
    return (
      <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: 12 + depth * 12 }}>
        Empty folder
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {children.map((c) => {
        const key = c.providerFileId;
        const isOpen = !!expanded[key];
        return (
          <li key={key}>
            <div
              className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {c.resourceType === "folder" ? (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {resourceIcon(c)}
              <span className="min-w-0 flex-1 truncate text-sm" title={c.name}>
                {c.name}
              </span>
              {c.viaFolderBind && (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  via folder
                </span>
              )}
              {c.webViewLink && (
                <a
                  href={c.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                  title="Open in Drive"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {c.resourceType === "folder" && isOpen && (
              <FolderChildren
                vaultId={vaultId}
                provider={c.provider}
                providerFileId={c.providerFileId}
                depth={depth + 1}
                searchQuery={searchQuery}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DriveBranch({
  vaultId,
  searchQuery = "",
}: {
  vaultId: string;
  searchQuery?: string;
}) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [shareTarget, setShareTarget] = useState<DriveResource | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const q = searchQuery.trim().toLowerCase();

  const accountsQuery = useQuery<{ accounts: ConnectedAccountRow[] }>({
    queryKey: ["/api/accounts"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/accounts");
      return res.json();
    },
  });

  const googleAccount =
    accountsQuery.data?.accounts?.find((a) => a.provider === "google") ?? null;
  const connectedAccountId = googleAccount?.accountId ?? null;

  const resourcesQuery = useQuery<{ resources: DriveResource[] }>({
    queryKey: ["/api/drive/resources", vaultId],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/drive/resources?vaultId=${encodeURIComponent(vaultId)}`,
      );
      return res.json();
    },
    enabled: !!vaultId,
  });

  const bindMutation = useMutation({
    mutationFn: async (docs: GoogleDoc[]) => {
      if (!connectedAccountId) throw new Error("No connected Google account");
      for (const doc of docs) {
        await apiRequest("POST", "/api/drive/resources", {
          vaultId,
          connectedAccountId,
          provider: "google",
          providerFileId: doc.id,
          name: doc.name,
          mimeType: doc.mimeType ?? null,
          resourceType:
            doc.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
          iconUrl: doc.iconUrl ?? null,
          webViewLink: doc.url ?? null,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/drive/resources", vaultId] });
      qc.invalidateQueries({ queryKey: ["/api/files/children"] });
    },
    onError: (err) => log.error("bind failed", { error: String(err) }),
  });

  const unbindMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/drive/resources/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/drive/resources", vaultId] });
      qc.invalidateQueries({ queryKey: ["/api/files/children"] });
    },
    onError: (err) => log.error("unbind failed", { error: String(err) }),
  });

  const openPicker = useCallback(async () => {
    if (!connectedAccountId) {
      log.warn("No connected Google account for picker");
      return;
    }
    setPicking(true);
    try {
      await loadPicker();
      const res = await apiRequest("POST", "/api/drive/picker-token", { connectedAccountId });
      const token = (await res.json()) as PickerToken;
      if (!token.configured || !token.accessToken || !token.apiKey) {
        throw new Error("Google Picker is not configured on this environment");
      }
      openGooglePicker({
        accessToken: token.accessToken,
        apiKey: token.apiKey,
        appId: token.appId,
        onPicked: (docs) => bindMutation.mutate(docs),
      });
    } catch (err) {
      log.error("picker open failed", { error: String(err) });
    } finally {
      setPicking(false);
    }
  }, [bindMutation, connectedAccountId]);

  const resources = (resourcesQuery.data?.resources ?? []).filter(
    (r) => !q || r.name.toLowerCase().includes(q),
  );
  const busy = picking || bindMutation.isPending;
  const pickerReady = !!connectedAccountId;

  return (
    <div className="flex flex-col gap-2" data-testid="drive-branch">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <HardDrive className="h-3.5 w-3.5" />
          Drive
        </div>
        <button
          type="button"
          onClick={openPicker}
          disabled={busy || !pickerReady}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
            (busy || !pickerReady) && "opacity-50 cursor-not-allowed",
          )}
          title={
            pickerReady
              ? "Add file or folder from Google Drive"
              : "Connect Google to add files"
          }
          data-testid="button-drive-add"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add
        </button>
      </div>

      {resourcesQuery.isLoading ? (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : resources.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">No Drive files bound yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {resources.map((r) => {
            const isOpen = !!expandedFolders[r.id];
            return (
              <li key={r.id}>
                <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60">
                  {r.resourceType === "folder" ? (
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground"
                      onClick={() =>
                        setExpandedFolders((s) => ({ ...s, [r.id]: !s[r.id] }))
                      }
                      aria-label={isOpen ? "Collapse folder" : "Expand folder"}
                      data-testid={`button-drive-expand-${r.id}`}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  {resourceIcon(r)}
                  <span className="min-w-0 flex-1 truncate text-sm" title={r.name}>
                    {r.name}
                  </span>
                  {r.webViewLink && (
                    <a
                      href={r.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                      title="Open in Drive"
                      data-testid={`link-drive-open-${r.id}`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setShareTarget(r)}
                    className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                    title="Share this file"
                    data-testid={`button-drive-share-${r.id}`}
                  >
                    <Share2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => unbindMutation.mutate(r.id)}
                    disabled={unbindMutation.isPending}
                    className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                    title="Remove bind"
                    data-testid={`button-drive-unbind-${r.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {r.resourceType === "folder" && isOpen && (
                  <FolderChildren
                    vaultId={vaultId}
                    driveResourceId={r.id}
                    depth={1}
                    searchQuery={searchQuery}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {shareTarget && (
        <ShareSheet
          open={!!shareTarget}
          onOpenChange={(open) => {
            if (!open) setShareTarget(null);
          }}
          objectType="drive_resource"
          objectId={shareTarget.id}
          title={shareTarget.name}
        />
      )}
    </div>
  );
}
