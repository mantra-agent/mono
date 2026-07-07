// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useCallback, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import html2canvas from "html2canvas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Camera, Loader2, X, ImageIcon, Pencil, Undo2, Check, Upload } from "lucide-react";

const log = createLogger("IssueCapture");

function getCurrentRoute(): string {
  const path = window.location.pathname || "/";
  const hash = window.location.hash;
  return hash ? `${path}${hash}` : path;
}

const DRAW_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#ffffff"];

function AnnotationOverlay({
  screenshotSrc,
  onSave,
  onCancel,
}: {
  screenshotSrc: string;
  onSave: (composited: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const scaleRef = useRef(1);
  const pathsRef = useRef<Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }>>([]);
  const currentPathRef = useRef<{ points: Array<{ x: number; y: number }>; color: string; width: number } | null>(null);
  const [color, setColor] = useState("#ef4444");
  const [canUndo, setCanUndo] = useState(false);

  useEffect(() => {
    pathsRef.current = [];
    setCanUndo(false);

    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const maxW = window.innerWidth * 0.92;
      const maxH = window.innerHeight * 0.78;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      scaleRef.current = scale;
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      redraw();
    };
    img.src = screenshotSrc;
  }, [screenshotSrc]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const path of pathsRef.current) {
      if (path.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = path.color;
      ctx.lineWidth = path.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.moveTo(path.points[0].x, path.points[0].y);
      for (let i = 1; i < path.points.length; i++) {
        ctx.lineTo(path.points[i].x, path.points[i].y);
      }
      ctx.stroke();
    }
  }, []);

  const getPos = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? 0;
      clientY = e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? 0;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    drawingRef.current = true;
    const pos = getPos(e);
    currentPathRef.current = { points: [pos], color, width: 3 };
  }, [color, getPos]);

  const moveDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingRef.current || !currentPathRef.current) return;
    e.preventDefault();
    const pos = getPos(e);
    currentPathRef.current.points.push(pos);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pts = currentPathRef.current.points;
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = currentPathRef.current.color;
    ctx.lineWidth = currentPathRef.current.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }, [getPos]);

  const endDraw = useCallback(() => {
    if (currentPathRef.current && currentPathRef.current.points.length > 1) {
      pathsRef.current.push(currentPathRef.current);
      setCanUndo(true);
    }
    currentPathRef.current = null;
    drawingRef.current = false;
  }, []);

  const handleUndo = useCallback(() => {
    pathsRef.current.pop();
    setCanUndo(pathsRef.current.length > 0);
    redraw();
  }, [redraw]);

  const handleSave = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;

    const offscreen = document.createElement("canvas");
    offscreen.width = img.naturalWidth;
    offscreen.height = img.naturalHeight;
    const ctx = offscreen.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);

    const invScale = 1 / scaleRef.current;
    for (const path of pathsRef.current) {
      if (path.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = path.color;
      ctx.lineWidth = path.width * invScale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.moveTo(path.points[0].x * invScale, path.points[0].y * invScale);
      for (let i = 1; i < path.points.length; i++) {
        ctx.lineTo(path.points[i].x * invScale, path.points[i].y * invScale);
      }
      ctx.stroke();
    }

    const dataUrl = offscreen.toDataURL("image/png", 0.8);
    onSave(dataUrl);
  }, [onSave]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center" data-testid="annotation-overlay">
      <div className="flex items-center gap-2 mb-3">
        {DRAW_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-7 h-7 rounded-full border-2 transition-transform ${color === c ? "border-white scale-110" : "border-transparent"}`}
            style={{ backgroundColor: c }}
            data-testid={`button-color-${c.replace("#", "")}`}
          />
        ))}
        <div className="w-px h-6 bg-white/30 mx-1" />
        <Button
          size="icon"
          variant="ghost"
          onClick={handleUndo}
          disabled={!canUndo}
          className="text-white"
          data-testid="button-annotation-undo"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
      </div>

      <canvas
        ref={canvasRef}
        className="cursor-crosshair rounded-md touch-none"
        onMouseDown={startDraw}
        onMouseMove={moveDraw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={moveDraw}
        onTouchEnd={endDraw}
        data-testid="canvas-annotation"
      />

      <div className="flex items-center gap-2 mt-3">
        <Button variant="outline" size="sm" onClick={onCancel} className="text-white border-white/30" data-testid="button-annotation-cancel">
          <X className="h-3.5 w-3.5 mr-1.5" />
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} data-testid="button-annotation-save">
          <Check className="h-3.5 w-3.5 mr-1.5" />
          Done
        </Button>
      </div>

      <p className="text-white/50 text-xs mt-2">Draw on the screenshot to annotate, then press Done</p>
    </div>
  );
}

export function openIssueCaptureDialog() {
  window.dispatchEvent(new CustomEvent("xyz-capture-issue"));
}

export function IssueCaptureDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(false);
  const routeRef = useRef<string>("/");
  const { toast } = useToast();

  useEffect(() => {
    const handler = () => {
      routeRef.current = getCurrentRoute();
      setTitle("");
      setDescription("");
      setScreenshot(null);
      setIncludeLogs(false);
      setOpen(true);
    };
    window.addEventListener("xyz-capture-issue", handler);
    return () => window.removeEventListener("xyz-capture-issue", handler);
  }, []);

  const { data: recentLogs } = useQuery<any[]>({
    queryKey: ["/api/logs/recent?limit=50"],
    enabled: includeLogs,
  });

  const submitMutation = useMutation({
    mutationFn: async (payload: { title: string; description: string; page: string; screenshot?: string; logs?: string }) => {
      const res = await apiRequest("POST", "/api/issues", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Issue captured" });
      setTitle("");
      setDescription("");
      setScreenshot(null);
      setIncludeLogs(false);
      setOpen(false);
      import("@/lib/queryClient").then(({ queryClient }) => {
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to capture", description: err.message, variant: "destructive" });
    },
  });

  const captureScreenshot = useCallback(async () => {
    setCapturing(true);
    setOpen(false);
    await new Promise((r) => setTimeout(r, 400));
    try {
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        scale: window.devicePixelRatio > 1 ? 1 : window.devicePixelRatio,
        logging: false,
        allowTaint: true,
        foreignObjectRendering: false,
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.scrollX,
        y: window.scrollY,
      });
      const dataUrl = canvas.toDataURL("image/png", 0.7);
      if (dataUrl && dataUrl.length > 100) {
        setScreenshot(dataUrl);
      } else {
        toast({ title: "Screenshot empty", description: "Nothing was captured.", variant: "destructive" });
      }
    } catch (err: any) {
      log.error("Screenshot capture error:", err);
      toast({ title: "Screenshot failed", description: err?.message || "Could not capture the screen.", variant: "destructive" });
    } finally {
      setCapturing(false);
      setOpen(true);
    }
  }, [toast]);

  const handleSubmit = () => {
    if (!title.trim() && !description.trim()) return;

    let logsText: string | undefined;
    if (includeLogs && recentLogs && recentLogs.length > 0) {
      logsText = recentLogs
        .slice(0, 30)
        .map((l: any) => `[${l.level}] ${l.source}: ${l.message}`)
        .join("\n");
    }

    submitMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      page: routeRef.current,
      screenshot: screenshot || undefined,
      logs: logsText,
    });
  };

  const openAnnotation = () => {
    setOpen(false);
    setAnnotating(true);
  };

  const handleAnnotationSave = (composited: string) => {
    setScreenshot(composited);
    setAnnotating(false);
    setOpen(true);
  };

  const handleAnnotationCancel = () => {
    setAnnotating(false);
    setOpen(true);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = (ev) => {
            const result = ev.target?.result as string;
            if (result) setScreenshot(result);
          };
          reader.readAsDataURL(file);
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [open]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      if (result) setScreenshot(result);
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  return (
    <>
      {annotating && screenshot && (
        <AnnotationOverlay
          screenshotSrc={screenshot}
          onSave={handleAnnotationSave}
          onCancel={handleAnnotationCancel}
        />
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Capture Issue</DialogTitle>
            <DialogDescription className="sr-only">Report an issue or suggest an improvement</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
              <span data-testid="text-issue-route">Page: {routeRef.current}</span>
            </div>

            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional — auto-generated if blank)"
              className="text-sm"
              autoFocus
              data-testid="input-issue-title"
            />

            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue or improvement in detail... (optional)"
              className="min-h-[80px] text-sm"
              data-testid="input-issue-description"
            />

            {screenshot && (
              <div className="space-y-1.5">
                <div className="relative rounded-md overflow-visible border">
                  <img
                    src={screenshot}
                    alt="Screenshot preview"
                    className="w-full h-auto max-h-32 object-cover object-top rounded-md"
                    data-testid="img-issue-screenshot"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-1 right-1 rounded-full bg-background/80"
                    onClick={() => setScreenshot(null)}
                    data-testid="button-remove-screenshot"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openAnnotation}
                  data-testid="button-annotate-screenshot"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Annotate
                </Button>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
              data-testid="input-image-upload"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={captureScreenshot}
                disabled={capturing}
                data-testid="button-take-screenshot"
              >
                {screenshot ? <ImageIcon className="h-3.5 w-3.5 mr-1.5" /> : <Camera className="h-3.5 w-3.5 mr-1.5" />}
                {screenshot ? "Retake" : "Screenshot"}
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-image"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Upload
              </Button>

              <div className="flex items-center gap-1.5">
                <Switch
                  checked={includeLogs}
                  onCheckedChange={setIncludeLogs}
                  data-testid="switch-include-logs"
                />
                <label className="text-sm text-muted-foreground cursor-pointer" onClick={() => setIncludeLogs(!includeLogs)}>
                  Logs
                </label>
              </div>

              <Button
                size="sm"
                className="ml-auto"
                onClick={handleSubmit}
                disabled={(!title.trim() && !description.trim()) || submitMutation.isPending}
                data-testid="button-submit-issue"
              >
                {submitMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Submit
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
