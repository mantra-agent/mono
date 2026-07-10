import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { formatBytes } from "@/lib/format-utils";
import {
  Loader2, RefreshCw, FolderOpen, ExternalLink, Files,
} from "lucide-react";
import type { ScratchFile, BucketFile } from "./types";

export function FilesTab() {
  const [subTab, setSubTab] = useState<"scratch" | "bucket">("scratch");
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const { data: scratchFiles, isLoading: scratchLoading, refetch: refetchScratch } = useQuery<ScratchFile[]>({
    queryKey: ["/api/info/files/scratch"],
    queryFn: async () => {
      const res = await fetch("/api/info/files/scratch", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: previewData, isLoading: previewLoading } = useQuery<{ path: string; content: string; size: number } | null>({
    queryKey: ["/api/info/files/scratch/read", previewPath],
    enabled: !!previewPath,
    queryFn: async () => {
      const res = await fetch(`/api/info/files/scratch/read?path=${encodeURIComponent(previewPath!)}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: bucketData, isLoading: bucketLoading, refetch: refetchBucket } = useQuery<{ bucketName: string | null; files: BucketFile[]; error?: string }>({
    queryKey: ["/api/info/files/bucket"],
    queryFn: async () => {
      const res = await fetch("/api/info/files/bucket", { credentials: "include" });
      return res.json();
    },
    staleTime: 30000,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex gap-0 border-b border-border px-4">
        {(["scratch", "bucket"] as const).map(t => (
          <button
            key={t}
            data-testid={`tab-files-${t}`}
            onClick={() => setSubTab(t)}
            className={cn(
              "px-4 py-2.5 text-xs font-medium border-b-2 transition-colors capitalize",
              subTab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "scratch" ? "Scratch" : "Object Storage"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {subTab === "scratch" && (
          <div className="flex gap-3 h-full">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium">Scratch Workspace Files</h3>
                <Button size="sm" variant="ghost" onClick={() => refetchScratch()} className="h-7 w-7 p-0" data-testid="button-refresh-scratch">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
              {scratchLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : !scratchFiles || scratchFiles.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No scratch files yet.</div>
              ) : (
                <div className="space-y-0.5">
                  {scratchFiles.map(f => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setPreviewPath(f.path === previewPath ? null : f.path)}
                      className={cn(
                        "w-full flex items-center gap-2 p-2 rounded hover:bg-accent/50 text-sm text-left",
                        previewPath === f.path && "bg-accent"
                      )}
                      data-testid={`file-scratch-${f.path}`}
                    >
                      <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-xs font-mono truncate flex-1">{f.path}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{formatBytes(f.size)}</span>
                      <span className="text-xs text-muted-foreground shrink-0 hidden @sm:block">
                        {formatDistanceToNow(new Date(f.mtime), { addSuffix: true })}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {previewPath && (
              <div className="w-1/2 shrink-0 border-l border-border pl-3 flex flex-col" data-testid="scratch-file-preview">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono text-muted-foreground truncate">{previewPath}</span>
                  <button type="button" onClick={() => setPreviewPath(null)} className="text-muted-foreground hover:text-foreground ml-2 shrink-0">✕</button>
                </div>
                {previewLoading ? (
                  <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                ) : !previewData ? (
                  <div className="text-xs text-muted-foreground">Could not read file</div>
                ) : (
                  <pre className="text-xs font-mono overflow-auto whitespace-pre-wrap break-all bg-muted/30 rounded p-2 flex-1" data-testid="scratch-file-content">
                    {previewData.content}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
        {subTab === "bucket" && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-medium">Object Storage</h3>
                {bucketData?.bucketName && (
                  <p className="text-xs text-muted-foreground font-mono">bucket: {bucketData.bucketName}</p>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => refetchBucket()} className="h-7 w-7 p-0" data-testid="button-refresh-bucket">
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            {bucketLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : bucketData?.error ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                <Files className="h-8 w-8 mx-auto opacity-20 mb-2" />
                <p>Object storage not available</p>
                <p className="text-xs mt-1 font-mono">{bucketData.error}</p>
              </div>
            ) : !bucketData?.files || bucketData.files.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No object storage files yet.</div>
            ) : (
              <div className="space-y-0.5">
                {bucketData.files.map(f => (
                  <div key={f.name} className="flex items-center gap-2 p-2 rounded hover:bg-accent/50" data-testid={`file-bucket-${f.name}`}>
                    <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono truncate flex-1">{f.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{formatBytes(f.size)}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{f.contentType || "?"}</span>
                    <a
                      href={f.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      data-testid={`link-download-${f.name}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
