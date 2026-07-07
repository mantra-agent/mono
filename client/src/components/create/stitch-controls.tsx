import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { createLogger } from "@/lib/logger";

const log = createLogger("StitchControls");

interface StitchControlsProps {
  clipIds: string[];
  disabled?: boolean;
}

export function StitchControls({ clipIds, disabled }: StitchControlsProps) {
  const [resolution, setResolution] = useState("original");
  const [outputName, setOutputName] = useState("stitched-output");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const { toast } = useToast();

  const cleanup = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startRender = useCallback(async () => {
    if (clipIds.length === 0) return;

    setError(null);
    setProgress(0);
    setStatus("starting");

    try {
      log.info("RENDER:START", { clipCount: clipIds.length, resolution, hasOutputName: Boolean(outputName) });
      const res = await apiRequest("POST", "/api/render/start", {
        clipIds,
        outputResolution: resolution === "original" ? null : resolution,
        outputName,
      });
      const job = await res.json();
      log.info("RENDER:JOB_CREATED", { jobId: job.id, clipCount: clipIds.length, resolution, hasOutputName: Boolean(outputName) });
      setJobId(job.id);
      setStatus("running");

      // Connect SSE
      const es = new EventSource(`/api/render/${job.id}/progress`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        setProgress(data.progress || 0);
        setStatus(data.status);

        if (data.status === "complete") {
          log.info("RENDER:COMPLETE", { jobId: job.id, hasDownloadUrl: Boolean(data.downloadUrl) });
          toast({ title: "Render complete!" });
          queryClient.invalidateQueries({ queryKey: ["/api/media"] });
          if (data.downloadUrl) {
            const a = document.createElement("a");
            a.href = data.downloadUrl;
            a.download = `${outputName}.mp4`;
            a.click();
          }
          cleanup();
          setTimeout(() => {
            setJobId(null);
            setStatus(null);
            setProgress(0);
          }, 3000);
        }

        if (data.status === "failed") {
          log.error("RENDER:FAILED", { jobId: job.id, error: String(data.error || "Render failed").slice(0, 300) });
          setError(data.error || "Render failed");
          cleanup();
        }
      };

      es.onerror = (evt) => {
        log.warn("RENDER:SSE_ERROR", { jobId: job.id });
      };
    } catch (err: any) {
      log.error("RENDER:START_FAILED", { error: String(err?.message || "Render start failed").slice(0, 300) });
      setError(err.message);
      setStatus(null);
    }
  }, [clipIds, resolution, outputName, toast, cleanup]);

  const cancelRender = useCallback(async () => {
    if (!jobId) return;
    try {
      log.info("RENDER:CANCEL:START", { jobId });
      await apiRequest("POST", `/api/render/${jobId}/cancel`);
      cleanup();
      setJobId(null);
      setStatus(null);
      setProgress(0);
      toast({ title: "Render canceled" });
    } catch (err: any) {
      log.error("RENDER:CANCEL_FAILED", { jobId, error: String(err?.message || "Cancel failed").slice(0, 300) });
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    }
  }, [jobId, toast, cleanup]);

  const isRendering = status === "running" || status === "starting";
  const isComplete = status === "complete";

  return (
    <div className="flex flex-col gap-3 p-3 border rounded-lg bg-card">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Output name"
          value={outputName}
          onChange={(e) => setOutputName(e.target.value)}
          className="h-8 text-sm flex-1"
          disabled={isRendering}
        />
        <Select value={resolution} onValueChange={setResolution} disabled={isRendering}>
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="original">Keep Original</SelectItem>
            <SelectItem value="720p">720p</SelectItem>
            <SelectItem value="1080p">1080p</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Progress bar */}
      {isRendering && (
        <div className="flex flex-col gap-1">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">Rendering... {progress}%</p>
        </div>
      )}

      {isComplete && (
        <div className="h-2 bg-success rounded-full" />
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex gap-2">
        {isRendering ? (
          <Button variant="destructive" size="sm" onClick={cancelRender} className="flex-1">
            <X className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={startRender}
            disabled={disabled || clipIds.length === 0}
            className="flex-1"
          >
            {status === "starting" ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : null}
            Render {clipIds.length} clip{clipIds.length !== 1 ? "s" : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
