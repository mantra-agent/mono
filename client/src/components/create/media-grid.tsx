import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2, Upload, Search, Film, Image, Music, Trash2, Plus, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { MediaUploadManager, type MediaUploadManagerHandle } from "./media-upload";
import { MediaPreview } from "./media-preview";
import { createLogger } from "@/lib/logger";
import type { MediaItem } from "@shared/models/media";

const log = createLogger("MediaGrid");

const TYPE_FILTERS = [
  { label: "All", value: "" },
  { label: "Video", value: "video", icon: Film },
  { label: "Image", value: "image", icon: Image },
  { label: "Audio", value: "audio", icon: Music },
];

interface MediaGridProps {
  videoOnly?: boolean;
  onAddToStitch?: (item: MediaItem) => void;
}

export function MediaGrid({ videoOnly, onAddToStitch }: MediaGridProps) {
  const [typeFilter, setTypeFilter] = useState(videoOnly ? "video" : "");
  const [search, setSearch] = useState("");
  const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const dropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<MediaUploadManagerHandle>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ items: MediaItem[]; total: number }>({
    queryKey: ["/api/media", typeFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (search) params.set("search", search);
      params.set("limit", "100");
      log.debug("MEDIA:FETCH:START", { typeFilter: typeFilter || "all", hasSearch: Boolean(search), limit: 100 });
      const res = await fetch(`/api/media?${params}`, { credentials: "include" });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log.error(`Media fetch failed: ${res.status} ${res.statusText} — ${errText}`);
        throw new Error("Failed to load media");
      }
      const data = await res.json();
      log.debug("MEDIA:FETCH:COMPLETE", { itemCount: data.items?.length ?? 0, total: data.total, typeFilter: typeFilter || "all", hasSearch: Boolean(search) });
      return data;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      log.info("MEDIA:DELETE:START", { mediaId: id });
      await apiRequest("DELETE", `/api/media/${id}`);
    },
    onSuccess: () => {
      log.info("MEDIA:DELETE:COMPLETE");
      queryClient.invalidateQueries({ queryKey: ["/api/media"] });
      setPreviewItem(null);
      toast({ title: "Media deleted" });
    },
    onError: (err: any) => {
      log.error(`Media delete failed: ${err.message}`);
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      log.info("MEDIA:RENAME:START", { mediaId: id, nextName: name });
      const res = await apiRequest("PATCH", `/api/media/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/media"] });
    },
    onError: (err: any) => {
      log.error(`Media rename failed: ${err.message}`);
      toast({ title: "Rename failed", variant: "destructive" });
    },
  });

  const startEditing = useCallback((e: React.MouseEvent, item: MediaItem) => {
    e.stopPropagation();
    setEditingId(item.id);
    setEditingName(item.name);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editingName.trim()) {
      renameMutation.mutate({ id: editingId, name: editingName.trim() });
    }
    setEditingId(null);
  }, [editingId, editingName, renameMutation]);

  const handleUploaded = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/media"] });
  }, []);

  /** Open file picker — called directly from button onClick, synchronous with user gesture */
  const openFilePicker = useCallback(() => {
    log.debug("MEDIA:FILE_PICKER:OPEN");
    fileInputRef.current?.click();
  }, []);

  /** Handle file selection from the native picker */
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    log.debug("MEDIA:FILE_PICKER:SELECT", { fileCount: files.length });
    uploadRef.current?.addFiles(files);
    // Reset so same file can be re-selected
    e.target.value = "";
  }, []);

  const items = data?.items || [];
  const isEmpty = !isLoading && items.length === 0 && !search && !typeFilter;

  function formatDuration(seconds: number | null): string {
    if (!seconds) return "";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function formatDate(date: string): string {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = diffMs / (1000 * 60 * 60);
    if (diffH < 1) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    const diffD = diffH / 24;
    if (diffD < 7) return `${Math.floor(diffD)}d ago`;
    return d.toLocaleDateString();
  }

  const typeIcon = (type: string) => {
    if (type === "video") return <Film className="h-3 w-3" />;
    if (type === "image") return <Image className="h-3 w-3" />;
    return <Music className="h-3 w-3" />;
  };

  return (
    <div
      ref={dropRef}
      className="flex flex-col gap-4 p-4 relative data-[drag-over=true]:ring-2 data-[drag-over=true]:ring-primary data-[drag-over=true]:ring-inset data-[drag-over=true]:bg-primary/5 transition-all"
    >
      {/* Hidden file input — owned by this component so click() is in the gesture call stack */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Headless upload manager — wires drag-drop and handles Uppy */}
      <MediaUploadManager
        ref={uploadRef}
        dropTargetRef={dropRef}
        onUploaded={handleUploaded}
      />

      {/* Filter bar */}
      {!videoOnly && (
        <div className="flex items-center gap-2 flex-wrap">
          {TYPE_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant={typeFilter === f.value ? "default" : "outline"}
              size="sm"
              onClick={() => setTypeFilter(f.value)}
            >
              {f.icon && <f.icon className="h-3.5 w-3.5 mr-1" />}
              {f.label}
            </Button>
          ))}
          <div className="relative ml-auto">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search media..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 w-48"
            />
          </div>
          <Button size="sm" onClick={openFilePicker}>
            <Upload className="h-3.5 w-3.5 mr-1" /> Upload
          </Button>
        </div>
      )}

      {/* Grid or zero state */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isEmpty ? (
        <div
          className="flex flex-col items-center justify-center py-12 gap-4 text-center cursor-pointer"
          onClick={openFilePicker}
        >
          <div className="rounded-full bg-muted p-4">
            <Upload className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-medium text-lg">Drop files here or click to upload</h3>
            <p className="text-sm text-muted-foreground mt-1">Images, video, and audio</p>
            <p className="text-xs text-muted-foreground mt-2">Images you generate in chat will appear here automatically.</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 @md:grid-cols-3 @lg:grid-cols-4 gap-3">
          {items.map((item) => (
            <Card
              key={item.id}
              className="group relative cursor-pointer overflow-hidden hover:ring-2 hover:ring-primary/50 transition-all"
              onClick={() => onAddToStitch ? onAddToStitch(item) : setPreviewItem(item)}
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-muted relative overflow-hidden">
                {(item.thumbPath || item.mediaType === "image") ? (
                  <img
                    src={item.thumbPath || item.objectPath}
                    alt={item.name}
                    className="absolute inset-0 w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    {typeIcon(item.mediaType)}
                  </div>
                )}
                {/* Play button overlay for videos */}
                {item.mediaType === "video" && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="rounded-full bg-black/50 p-2 opacity-80 group-hover:opacity-100 transition-opacity">
                      <Play className="h-5 w-5 text-white fill-white" />
                    </div>
                  </div>
                )}
                {/* Duration badge */}
                {item.duration && (
                  <Badge variant="secondary" className="absolute bottom-1 right-1 text-xs px-1 py-0">
                    {formatDuration(item.duration)}
                  </Badge>
                )}
                {/* Add to stitch button */}
                {onAddToStitch && item.mediaType === "video" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="absolute bottom-1 left-1 h-6 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); onAddToStitch(item); }}
                  >
                    <Plus className="h-3 w-3 mr-0.5" /> Add
                  </Button>
                )}
              </div>
              {/* Info */}
              <div className="p-2">
                {editingId === item.id ? (
                  <input
                    autoFocus
                    className="text-xs font-medium w-full bg-transparent border-b border-primary outline-none"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <p
                    className="text-xs font-medium truncate cursor-text hover:text-primary transition-colors"
                    onClick={(e) => startEditing(e, item)}
                  >
                    {item.name}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Preview dialog */}
      {previewItem && (
        <MediaPreview
          item={previewItem}
          onClose={() => setPreviewItem(null)}
          onDelete={(id) => deleteMutation.mutate(id)}
        />
      )}
    </div>
  );
}
