// Use createLogger for logging ONLY
import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2,
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { hexToRgba } from "@/lib/vault-title-color";

/**
 * Read-only connector tree primitive.
 *
 * This is the data-plane view of vault-bound provider resources (Google Drive,
 * Box, Mantra storage). It renders bound roots and lets you drill into folders
 * and open files in their provider — nothing more. The control plane (connect,
 * bind a folder via Picker, unbind, share) lives in the Integrations surface,
 * NOT here. Keeping this primitive free of mutations is what lets the Files
 * page mirror the Library tree without dragging connector management onto it.
 */

export interface DriveResource {
  id: string;
  provider: "google" | "box" | "mantra";
  providerFileId: string;
  name: string;
  mimeType: string | null;
  resourceType: "file" | "folder";
  iconUrl: string | null;
  webViewLink: string | null;
}

export interface FilesChild {
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

export function resourceIcon(r: { resourceType: "file" | "folder" }) {
  return r.resourceType === "folder" ? (
    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
  );
}

function titleStyleForVault(vaultColor?: string | null): CSSProperties | undefined {
  if (!vaultColor) return undefined;
  const color = hexToRgba(vaultColor, 1) ?? vaultColor;
  return { color };
}

/** File/folder title — clickable provider link when a webViewLink exists. */
function ResourceTitle({
  name,
  href,
  titleStyle,
}: {
  name: string;
  href: string | null;
  titleStyle?: CSSProperties;
}) {
  const className = "min-w-0 flex-1 truncate text-sm";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(className, "hover:underline")}
        style={titleStyle}
        title={name}
      >
        {name}
      </a>
    );
  }
  return (
    <span className={className} style={titleStyle} title={name}>
      {name}
    </span>
  );
}

/** Recursively lists the children of a bound folder. Read-only. */
function FolderChildren({
  vaultId,
  driveResourceId,
  provider,
  providerFileId,
  depth,
  vaultColor,
}: {
  vaultId: string;
  driveResourceId?: string;
  provider?: "google" | "box" | "mantra";
  providerFileId?: string;
  depth: number;
  vaultColor?: string | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const titleStyle = titleStyleForVault(vaultColor);

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

  const children = childrenQuery.data?.children ?? [];
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
        const isFolder = c.resourceType === "folder";
        return (
          <li key={key}>
            <div
              className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {isFolder ? (
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
              <ResourceTitle name={c.name} href={c.webViewLink} titleStyle={titleStyle} />
            </div>
            {isFolder && isOpen && (
              <FolderChildren
                vaultId={vaultId}
                driveResourceId={c.driveResourceId ?? undefined}
                provider={c.provider}
                providerFileId={c.providerFileId}
                depth={depth + 1}
                vaultColor={vaultColor}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Read-only tree of the bound connector resources for a single vault. Accepts
 * the already-fetched roots so a parent can fetch once and reuse the data for a
 * cross-vault RECENT list (react-query dedupes the children calls regardless).
 */
export function DriveResourceTree({
  vaultId,
  resources,
  emptyLabel = "No files",
  vaultColor,
}: {
  vaultId: string;
  resources: DriveResource[];
  emptyLabel?: string;
  vaultColor?: string | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const titleStyle = titleStyleForVault(vaultColor);

  if (resources.length === 0) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 8 }}>
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {resources.map((r) => {
        const isOpen = !!expanded[r.id];
        const isFolder = r.resourceType === "folder";
        return (
          <li key={r.id}>
            <div
              className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground"
                  onClick={() => setExpanded((s) => ({ ...s, [r.id]: !s[r.id] }))}
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
              {resourceIcon(r)}
              <ResourceTitle name={r.name} href={r.webViewLink} titleStyle={titleStyle} />
            </div>
            {isFolder && isOpen && (
              <FolderChildren
                vaultId={vaultId}
                driveResourceId={r.id}
                provider={r.provider}
                providerFileId={r.providerFileId}
                depth={1}
                vaultColor={vaultColor}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A row in the flat cross-vault RECENT list (no vault badge). */
export function RecentResourceRow({
  resource,
  vaultColor,
}: {
  resource: DriveResource;
  vaultColor?: string | null;
}) {
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60">
      <span className="w-3.5 shrink-0" />
      {resourceIcon(resource)}
      <ResourceTitle
        name={resource.name}
        href={resource.webViewLink}
        titleStyle={titleStyleForVault(vaultColor)}
      />
    </div>
  );
}
