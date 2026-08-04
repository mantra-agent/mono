import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ExternalLink, X, HardDrive, Plus, Share2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { ShareSheet } from "@/components/sharing/share-sheet";

const log = createLogger("DriveBranch");

interface DriveResource {
  id: string;
  googleFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
}

interface PickerToken {
  configured: boolean;
  accessToken?: string;
  apiKey?: string;
  appId?: string | null;
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
    script.onload = finish;
    script.onerror = () => reject(new Error("Failed to load Google Picker"));
    document.body.appendChild(script);
  });
  return pickerLoad;
}

/**
 * A vault's Drive branch in the Files tree: bound Google Drive files render as same-grammar rows.
 * "Add from Drive" opens the Google Picker (drive.file) when a browser API key is configured; when
 * it is not, the action degrades to a disabled, explained state rather than a broken picker.
 * Removing a row unbinds the pointer — it never deletes the underlying Google file.
 */
export function DriveBranch({ vaultId, searchQuery = "" }: { vaultId: string; searchQuery?: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ resources: DriveResource[] }>({
    queryKey: ["/api/drive/resources", vaultId],
    queryFn: async () => (await apiRequest("GET", `/api/drive/resources?vaultId=${encodeURIComponent(vaultId)}`)).json(),
  });
  const allResources = data?.resources ?? [];
  // Federated title search: Drive is title-only (drive.file exposes just picked files, so our bound
  // rows are the authoritative Drive index). When searching, filter by name and collapse the whole
  // branch if nothing matches so the results read as one unified list with native pages.
  const query = searchQuery.trim().toLowerCase();
  const resources = query ? allResources.filter((r) => r.name.toLowerCase().includes(query)) : allResources;
  const hiddenBySearch = query.length > 0 && resources.length === 0;

  const { data: status } = useQuery<{ drivePickerConfigured?: boolean }>({
    queryKey: ["/api/gmail/status"],
    queryFn: async () => (await apiRequest("GET", "/api/gmail/status")).json(),
  });
  const { data: accounts } = useQuery<Array<{ id: string }>>({
    queryKey: ["/api/gmail/accounts"],
    queryFn: async () => (await apiRequest("GET", "/api/gmail/accounts")).json(),
  });
  const connectedAccountId = accounts?.[0]?.id;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/drive/resources", vaultId] });

  const unbindMutation = useMutation<unknown, Error, string>({
    mutationFn: async (id) => {
      await apiRequest("DELETE", `/api/drive/resources/${id}`);
    },
    onSuccess: invalidate,
    onError: (err) => setError(err.message || "Failed to remove"),
  });

  const openPicker = useCallback(async () => {
    setError(null);
    if (!connectedAccountId) {
      setError("Connect a Google account with Drive first.");
      return;
    }
    setBusy(true);
    try {
      const token: PickerToken = await (await apiRequest("GET", `/api/drive/picker-token?connectedAccountId=${encodeURIComponent(connectedAccountId)}`)).json();
      if (!token.configured || !token.accessToken || !token.apiKey) {
        setError("Drive picking isn't configured on the server (GOOGLE_PICKER_API_KEY).");
        return;
      }
      await loadPicker();
      const g = (window as unknown as { google: any }).google;
      const view = new g.picker.DocsView(g.picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true);
      const builder = new g.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token.accessToken)
        .setDeveloperKey(token.apiKey)
        .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
        .setCallback(async (result: any) => {
          if (result[g.picker.Response.ACTION] !== g.picker.Action.PICKED) return;
          const docs = result[g.picker.Response.DOCUMENTS] || [];
          for (const doc of docs) {
            await apiRequest("POST", "/api/drive/resources", {
              vaultId,
              connectedAccountId,
              googleFileId: doc[g.picker.Document.ID],
              name: doc[g.picker.Document.NAME],
              mimeType: doc[g.picker.Document.MIME_TYPE],
              resourceType: doc[g.picker.Document.TYPE] === "folder" ? "folder" : "file",
              iconUrl: doc[g.picker.Document.ICON_URL],
              webViewLink: doc[g.picker.Document.URL],
            });
          }
          invalidate();
        });
      if (token.appId) builder.setAppId(token.appId);
      builder.build().setVisible(true);
    } catch (err) {
      log.error("picker failed", { error: err instanceof Error ? err.message : String(err) });
      setError(err instanceof Error ? err.message : "Failed to open Drive picker");
    } finally {
      setBusy(false);
    }
  }, [connectedAccountId, vaultId, queryClient]);

  const pickerReady = status?.drivePickerConfigured !== false;

  // During an active search with no Drive title matches, collapse the branch entirely so results
  // read as one federated list. Hooks above always run, so this conditional return is safe.
  if (hiddenBySearch) return null;

  return (
    <div className="ml-6 mt-1 border-l border-border pl-3" data-testid={`drive-branch-${vaultId}`}>
      <div className="flex items-center gap-2 py-1">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Drive</span>
        <button
          type="button"
          onClick={openPicker}
          disabled={busy || !pickerReady}
          className={cn(
            "ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
            pickerReady ? "text-muted-foreground hover:bg-accent hover:text-foreground" : "cursor-not-allowed text-muted-foreground/50",
          )}
          title={pickerReady ? "Add files from Google Drive" : "Set GOOGLE_PICKER_API_KEY on the server to enable Drive picking"}
          data-testid={`button-drive-add-${vaultId}`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add from Drive
        </button>
      </div>

      {error && <p className="py-0.5 text-xs text-destructive">{error}</p>}

      {isLoading ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : resources.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/70">No Drive files bound yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {resources.map((r) => (
            <li key={r.id} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-accent" data-testid={`drive-row-${r.id}`}>
              {r.iconUrl ? (
                <img src={r.iconUrl} alt="" className="h-3.5 w-3.5" />
              ) : (
                <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.name}</span>
              {r.webViewLink && (
                <a
                  href={r.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                  title="Open in Drive"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <button
                type="button"
                onClick={() => setShareId(r.id)}
                className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                title="Share this file"
                data-testid={`button-drive-share-${r.id}`}
              >
                <Share2 className="h-3.5 w-3.5" />
              </button>
              <ShareSheet
                objectType="drive_resource"
                objectId={r.id}
                title={r.name}
                open={shareId === r.id}
                onOpenChange={(o) => setShareId(o ? r.id : null)}
              />
              <button
                type="button"
                onClick={() => unbindMutation.mutate(r.id)}
                disabled={unbindMutation.isPending}
                className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                title="Remove from Files (does not delete the Google file)"
                data-testid={`button-drive-unbind-${r.id}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
