import { useCallback, useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { createLogger } from "@/lib/logger";

const log = createLogger("MediaUpload");

export interface MediaUploadManagerHandle {
  addFiles: (files: FileList) => void;
}

interface MediaUploadManagerProps {
  /** Ref to a drop target element — files dropped on it will be uploaded */
  dropTargetRef: React.RefObject<HTMLElement | null>;
  /** Called after uploads complete and media is registered */
  onUploaded: () => void;
}

/**
 * Headless upload manager — no UI of its own except a progress indicator.
 * Provides drag-drop on a target element and an imperative addFiles() handle.
 *
 * Uploads go through the server proxy (POST /api/uploads/file) to avoid
 * CORS issues with direct-to-S3 presigned PUTs.
 */
export const MediaUploadManager = forwardRef<MediaUploadManagerHandle, MediaUploadManagerProps>(
  function MediaUploadManager({ dropTargetRef, onUploaded }, ref) {
    const { toast } = useToast();
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);

    const addFilesToUppy = useCallback(async (files: FileList) => {
      setUploading(true);
      setProgress(0);

      const results: { name: string; objectPath: string; type: string; size: number }[] = [];
      const failures: { name: string; error: string }[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        log.debug("MEDIA:UPLOAD:START", { fileName: file.name, fileSize: file.size, fileType: file.type || "unknown", index: i + 1, total: files.length });

        try {
          const formData = new FormData();
          formData.append("file", file);

          const res = await fetch("/api/uploads/file", {
            method: "POST",
            body: formData,
            credentials: "include",
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Upload failed" }));
            throw new Error(err.error || `HTTP ${res.status}`);
          }

          const data = await res.json();
          log.info("MEDIA:UPLOAD:COMPLETE", { fileName: file.name, fileSize: file.size, fileType: file.type || "unknown", hasObjectPath: Boolean(data.objectPath) });
          results.push({ name: file.name, objectPath: data.objectPath, type: file.type, size: file.size });
        } catch (err: any) {
          log.error("MEDIA:UPLOAD:FAILED", { fileName: file.name, error: String(err?.message || "Upload failed").slice(0, 300) });
          failures.push({ name: file.name, error: err.message });
        }

        setProgress(Math.round(((i + 1) / files.length) * 80));
      }

      // Register all successful uploads
      for (const file of results) {
        const mimeType = file.type || "application/octet-stream";
        const mediaType = mimeType.startsWith("video/") ? "video"
          : mimeType.startsWith("image/") ? "image"
          : mimeType.startsWith("audio/") ? "audio"
          : "image";
        try {
          log.debug("MEDIA:REGISTER:START", { fileName: file.name, mediaType, hasObjectPath: Boolean(file.objectPath), fileSize: file.size });
          await apiRequest("POST", "/api/media/register", {
            name: file.name,
            mediaType,
            source: "upload",
            objectPath: file.objectPath,
            mimeType,
            fileSize: file.size || null,
          });
          log.info("MEDIA:REGISTER:COMPLETE", { fileName: file.name, mediaType, hasObjectPath: Boolean(file.objectPath) });
        } catch (regErr: any) {
          log.error("MEDIA:REGISTER:FAILED", { fileName: file.name, mediaType, error: String(regErr?.message || "Registration failed").slice(0, 300) });
          toast({
            title: "Registration failed",
            description: `"${file.name}": ${regErr.message}`,
            variant: "destructive",
          });
        }
      }

      setProgress(100);

      if (failures.length > 0) {
        toast({
          title: `${failures.length} upload${failures.length > 1 ? "s" : ""} failed`,
          description: failures.map(f => f.name).join(", "),
          variant: "destructive",
        });
      }

      if (results.length > 0) {
        toast({ title: `${results.length} file${results.length > 1 ? "s" : ""} uploaded` });
        onUploaded();
      }

      setUploading(false);
    }, [toast, onUploaded]);

    // Expose addFiles to parent via imperative handle
    useImperativeHandle(ref, () => ({
      addFiles: addFilesToUppy,
    }), [addFilesToUppy]);

    // Wire drag-drop to the target element
    useEffect(() => {
      const el = dropTargetRef.current;
      if (!el) return;

      const prevent = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };

      const handleDragEnter = (e: DragEvent) => {
        prevent(e);
        el.dataset.dragOver = "true";
      };
      const handleDragLeave = (e: DragEvent) => {
        prevent(e);
        const related = e.relatedTarget as Node | null;
        if (!el.contains(related)) {
          delete el.dataset.dragOver;
        }
      };
      const handleDragOver = (e: DragEvent) => prevent(e);
      const handleDrop = (e: DragEvent) => {
        prevent(e);
        delete el.dataset.dragOver;
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        log.debug("MEDIA:DROP:RECEIVED", { fileCount: files.length });
        addFilesToUppy(files);
      };

      el.addEventListener("dragenter", handleDragEnter);
      el.addEventListener("dragleave", handleDragLeave);
      el.addEventListener("dragover", handleDragOver);
      el.addEventListener("drop", handleDrop);
      return () => {
        el.removeEventListener("dragenter", handleDragEnter);
        el.removeEventListener("dragleave", handleDragLeave);
        el.removeEventListener("dragover", handleDragOver);
        el.removeEventListener("drop", handleDrop);
      };
    }, [dropTargetRef, addFilesToUppy]);

    return uploading ? (
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-background border rounded-lg px-4 py-2 shadow-lg">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Uploading... {progress}%</span>
      </div>
    ) : null;
  }
);
