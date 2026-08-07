// Use createLogger for logging ONLY
import { useState, type CSSProperties, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2,
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { hexToRgba } from "@/lib/vault-title-color";

/**
 * Read-only connector tree primitive.
 *
 * This is the data-plane view of vault-bound provider resources (Google Drive,
 * Box, Mantra storage). It renders bound roots and lets you drill into folders
 * and open files — PDFs open in the in-product viewer; other files keep the
 * provider link. The control plane (connect, bind, unbind, share) lives in
 * Integrations, not here.
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

function isPdfResource(resource: {
  name: string;
  mimeType: string | null;
}): boolean {
  const mime = (resource.mimeType || "").toLowerCase();
  if (mime === "application/pdf" || mime.includes("pdf")) return true;
  return resource.name.toLowerCase().endsWith(".pdf");
}

function providerOpenLabel(provider: "google" | "box" | "mantra"): string {
  if (provider === "box") return "Open in Box";
  if (provider === "mantra") return "Open source";
  return "Open in Google";
}

function pdfViewerHref(args: {
  id: string;
  source: "drive_resource" | "provider";
  vaultId?: string;
  provider?: "google" | "box" | "mantra";
  providerFileId?: string;
  webViewLink?: string | null;
}): string {
  const params = new URLSearchParams({ source: args.source });
  if (args.vaultId) params.set("vaultId", args.vaultId);
  if (args.provider) {
    params.set("provider", args.provider);
    params.set("providerLabel", providerOpenLabel(args.provider));
  }
  if (args.webViewLink) {
    params.set("providerHref", args.webViewLink);
  }
  const routeId =
    args.source === "provider" && args.providerFileId
      ? args.providerFileId
      : args.id;
  return `/documents/${encodeURIComponent(routeId)}?${params.toString()}`;
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

/** File/folder title — PDF opens in-product; other files keep provider links. */
function ResourceTitle({
  name,
  href,
  titleStyle,
  onOpen,
}: {
  name: string;
  href: string | null;
  titleStyle?: CSSProperties;
  onOpen?: (event: MouseEvent) => void;
}) {
  const className = "min-h-11 min-w-0 flex-1 truncate text-left text-sm leading-[44px]";
  if (onOpen) {
    return (
      <button
        type="button"
        className={cn(className, "hover:underline")}
        style={titleStyle}
        title={name}
        onClick={onOpen}
      >
        {name}
      </button>
    );
  }
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

function ExternalOpenLink({
  href,
  label,
}: {
  href: string | null;
  label: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
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
  const [, setLocation] = useLocation();
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
        const isPdf = !isFolder && isPdfResource(c);
        const openPdf = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (c.driveResourceId) {
            setLocation(
              pdfViewerHref({
                id: c.driveResourceId,
                source: "drive_resource",
                vaultId,
                provider: c.provider,
                webViewLink: c.webViewLink,
              }),
            );
            return;
          }
          setLocation(
            pdfViewerHref({
              id: c.providerFileId,
              source: "provider",
              vaultId,
              provider: c.provider,
              providerFileId: c.providerFileId,
              webViewLink: c.webViewLink,
            }),
          );
        };
        return (
          <li key={key}>
            <div
              className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
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
              <ResourceTitle
                name={c.name}
                href={isPdf ? null : c.webViewLink}
                titleStyle={titleStyle}
                onOpen={isPdf ? openPdf : undefined}
              />
              {isPdf ? (
                <ExternalOpenLink href={c.webViewLink} label={providerOpenLabel(c.provider)} />
              ) : null}
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
  const [, setLocation] = useLocation();
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
        const isPdf = !isFolder && isPdfResource(r);
        const openPdf = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          setLocation(
            pdfViewerHref({
              id: r.id,
              source: "drive_resource",
              vaultId,
              provider: r.provider,
              webViewLink: r.webViewLink,
            }),
          );
        };
        return (
          <li key={r.id}>
            <div
              className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60"
              style={{ paddingLeft: 8 }}
            >
              {isFolder ? (
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
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
              <ResourceTitle
                name={r.name}
                href={isPdf ? null : r.webViewLink}
                titleStyle={titleStyle}
                onOpen={isPdf ? openPdf : undefined}
              />
              {isPdf ? (
                <ExternalOpenLink href={r.webViewLink} label={providerOpenLabel(r.provider)} />
              ) : null}
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
  vaultId,
  vaultColor,
}: {
  resource: DriveResource;
  vaultId?: string;
  vaultColor?: string | null;
}) {
  const [, setLocation] = useLocation();
  const isPdf = isPdfResource(resource);
  const openPdf = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setLocation(
      pdfViewerHref({
        id: resource.id,
        source: "drive_resource",
        vaultId,
        provider: resource.provider,
        webViewLink: resource.webViewLink,
      }),
    );
  };

  return (
    <div className="group flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-muted/60">
      <span className="w-3.5 shrink-0" />
      {resourceIcon(resource)}
      <ResourceTitle
        name={resource.name}
        href={isPdf ? null : resource.webViewLink}
        titleStyle={titleStyleForVault(vaultColor)}
        onOpen={isPdf ? openPdf : undefined}
      />
      {isPdf ? (
        <ExternalOpenLink
          href={resource.webViewLink}
          label={providerOpenLabel(resource.provider)}
        />
      ) : null}
    </div>
  );
}
