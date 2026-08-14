import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createLogger } from "@/lib/logger";
import {
  loadPdfJs,
  pdfWorkerSrc,
  type PdfJsDocument,
  type PdfJsModule,
  type PdfJsPage,
} from "@/lib/pdfjs";
import { cn } from "@/lib/utils";

const log = createLogger("PdfViewer");

export type PdfOpenSource =
  | { kind: "document"; documentId: string }
  | { kind: "drive_resource"; driveResourceId: string; vaultId?: string }
  | {
      kind: "provider";
      provider: "google" | "box" | "mantra";
      providerFileId: string;
      vaultId: string;
      rootDriveResourceId?: string;
    }
  | { kind: "object"; objectPath: string };

export interface PdfViewerSourceContext {
  vaultName?: string | null;
  filesHref?: string | null;
  providerLabel?: string | null;
  providerHref?: string | null;
}

export interface PdfViewerProps {
  source: PdfOpenSource;
  className?: string;
  onTitle?: (title: string) => void;
  sourceContext?: PdfViewerSourceContext;
}

type OpenResponse = {
  handle: string;
  streamUrl: string;
  metadata: {
    documentId: string | null;
    title: string;
    mimeType: string;
    byteSize: number;
    pageCount: number | null;
    sourceKind: string;
  };
};

type ZoomMode = "number" | "fit-width" | "fit-page";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.15;

type CodedError = Error & { code: string };

function httpFailureCode(prefix: "OPEN" | "CONTENT", status: number): string {
  if (status === 400) return `${prefix}_HTTP_400`;
  if (status === 403) return `${prefix}_HTTP_403`;
  if (status === 404) return `${prefix}_HTTP_404`;
  if (status === 415) return `${prefix}_HTTP_415`;
  if (status === 502) return `${prefix}_HTTP_502`;
  if (status >= 500) return `${prefix}_HTTP_500`;
  return `${prefix}_HTTP`;
}

function codedError(message: string, code: string, cause?: unknown): CodedError {
  const error = (cause === undefined ? new Error(message) : new Error(message, { cause })) as CodedError;
  error.code = code;
  return error;
}

function asCodedError(err: unknown, fallbackMessage: string, fallbackCode: string): CodedError {
  if (err instanceof Error) {
    const existing = (err as Error & { code?: string }).code;
    if (typeof existing === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(existing)) {
      return err as CodedError;
    }
    return codedError(err.message || fallbackMessage, fallbackCode, err);
  }
  return codedError(fallbackMessage, fallbackCode, err);
}

function openBody(source: PdfOpenSource): Record<string, string> {
  switch (source.kind) {
    case "document":
      return { documentId: source.documentId };
    case "drive_resource":
      return {
        driveResourceId: source.driveResourceId,
        ...(source.vaultId ? { vaultId: source.vaultId } : {}),
      };
    case "provider":
      return {
        provider: source.provider,
        providerFileId: source.providerFileId,
        vaultId: source.vaultId,
        ...(source.rootDriveResourceId ? { rootDriveResourceId: source.rootDriveResourceId } : {}),
      };
    case "object":
      return { objectPath: source.objectPath };
  }
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function PdfViewer({ source, className, onTitle, sourceContext }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const pdfjsRef = useRef<PdfJsModule | null>(null);
  const docRef = useRef<PdfJsDocument | null>(null);
  const pageRef = useRef<PdfJsPage | null>(null);
  const findStateRef = useRef<{ query: string; matches: number[]; index: number }>({
    query: "",
    matches: [],
    index: -1,
  });

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("PDF");
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit-width");
  const [zoom, setZoom] = useState(1);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);

  const sourceKey = useMemo(() => JSON.stringify(source), [source]);

  const paintPage = useCallback(async (pageNum: number, mode: ZoomMode, explicitZoom: number) => {
    const pdfjs = pdfjsRef.current;
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const textLayer = textLayerRef.current;
    const stage = stageRef.current;
    if (!pdfjs || !doc || !canvas || !textLayer || !stage) return;

    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    const page = await doc.getPage(pageNum);
    pageRef.current = page;

    const base = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(stage.clientWidth - 32, 120);
    const availableHeight = Math.max(stage.clientHeight - 32, 120);
    let nextZoom = explicitZoom;
    if (mode === "fit-width") nextZoom = availableWidth / base.width;
    if (mode === "fit-page") {
      nextZoom = Math.min(availableWidth / base.width, availableHeight / base.height);
    }
    nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    setZoom(nextZoom);

    const viewport = page.getViewport({ scale: nextZoom * (window.devicePixelRatio || 1) });
    const cssViewport = page.getViewport({ scale: nextZoom });
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;

    textLayer.innerHTML = "";
    textLayer.style.width = canvas.style.width;
    textLayer.style.height = canvas.style.height;

    const task = page.render({
      canvasContext: context,
      viewport,
      canvas,
    });
    renderTaskRef.current = task;
    await task.promise;

    if (pdfjs.TextLayer) {
      const textContent = await page.getTextContent();
      await pdfjs.TextLayer.render({
        textContentSource: textContent,
        container: textLayer,
        viewport: cssViewport,
      }).promise;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function openAndLoad() {
      setStatus("loading");
      setError(null);
      setStreamUrl(null);
      setPageNumber(1);
      setPageCount(0);

      try {
        const openRes = await fetch("/api/pdf/open", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(openBody(source)),
          signal: controller.signal,
        });
        if (!openRes.ok) {
          const payload = await openRes.json().catch(() => ({}));
          throw codedError(
            typeof payload?.error === "string" ? payload.error : `Open failed (${openRes.status})`,
            httpFailureCode("OPEN", openRes.status),
          );
        }
        const opened = (await openRes.json()) as OpenResponse;
        if (cancelled) return;

        setTitle(opened.metadata.title || "PDF");
        onTitle?.(opened.metadata.title || "PDF");
        setStreamUrl(opened.streamUrl);

        const contentRes = await fetch(opened.streamUrl, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!contentRes.ok) {
          const payload = await contentRes.json().catch(() => ({}));
          throw codedError(
            typeof payload?.error === "string"
              ? payload.error
              : `Content failed (${contentRes.status})`,
            httpFailureCode("CONTENT", contentRes.status),
          );
        }
        const bytes = new Uint8Array(await contentRes.arrayBuffer());
        if (cancelled) return;

        let pdfjs;
        try {
          pdfjs = await loadPdfJs();
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
          pdfjsRef.current = pdfjs;
        } catch (err) {
          throw codedError(
            err instanceof Error ? err.message : "Failed to load PDF renderer",
            "PDFJS_LOAD",
            err,
          );
        }

        docRef.current?.destroy();
        let doc;
        try {
          const loadingTask = pdfjs.getDocument({ data: bytes });
          doc = await loadingTask.promise;
        } catch (err) {
          throw codedError(
            err instanceof Error ? err.message : "Failed to parse PDF",
            "PDFJS_PARSE",
            err,
          );
        }
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setStatus("ready");
        try {
          await paintPage(1, "fit-width", 1);
        } catch (err) {
          throw codedError(
            err instanceof Error ? err.message : "Failed to render page",
            "PAINT",
            err,
          );
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const failure = asCodedError(err, "Failed to open PDF", "OPEN_UNKNOWN");
        log.error("PDF viewer open failed", failure);
        setError(failure.message);
        setStatus("error");
      }
    }

    void openAndLoad();
    return () => {
      cancelled = true;
      controller.abort();
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      void docRef.current?.destroy();
      docRef.current = null;
      pageRef.current = null;
    };
  }, [source, sourceKey, onTitle, paintPage]);

  useEffect(() => {
    if (status !== "ready") return;
    void paintPage(pageNumber, zoomMode, zoom).catch((err) => {
      const failure = asCodedError(err, "Failed to render page", "PAINT");
      log.error("PDF page render failed", failure);
      setError(failure.message);
      setStatus("error");
    });
  }, [pageNumber, zoomMode, status]); // eslint-disable-line react-hooks/exhaustive-deps -- zoom handled via mode/buttons

  const goToPage = (next: number) => {
    if (!pageCount) return;
    setPageNumber(Math.min(pageCount, Math.max(1, next)));
  };

  const zoomBy = (delta: number) => {
    setZoomMode("number");
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + delta)));
    void paintPage(pageNumber, "number", Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta)));
  };

  const downloadOriginal = async () => {
    if (!streamUrl) return;
    try {
      const res = await fetch(streamUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = title.endsWith(".pdf") ? title : `${title}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      log.error("PDF download failed", { message });
      setError(message);
    }
  };

  const runFind = async (direction: 1 | -1 | 0) => {
    const query = findQuery.trim();
    if (!query || !docRef.current) {
      setFindStatus(null);
      return;
    }
    const state = findStateRef.current;
    if (state.query !== query || state.matches.length === 0) {
      const matches: number[] = [];
      const needle = query.toLowerCase();
      for (let i = 1; i <= docRef.current.numPages; i += 1) {
        const page = await docRef.current.getPage(i);
        const content = (await page.getTextContent()) as { items?: Array<{ str?: string }> };
        const text = (content.items ?? []).map((item) => item.str ?? "").join(" ").toLowerCase();
        if (text.includes(needle)) matches.push(i);
      }
      state.query = query;
      state.matches = matches;
      state.index = matches.length ? 0 : -1;
    } else if (direction !== 0 && state.matches.length) {
      state.index = (state.index + direction + state.matches.length) % state.matches.length;
    }

    if (!state.matches.length) {
      setFindStatus("No matches");
      return;
    }
    const target = state.matches[state.index]!;
    setFindStatus(`${state.index + 1} of ${state.matches.length}`);
    if (target !== pageNumber) setPageNumber(target);
  };

  if (status === "loading") {
    return (
      <div className={cn("flex h-full items-center justify-center bg-background", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading PDF" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center gap-2 bg-background px-4", className)}>
        <p className="text-sm text-destructive">{error || "Unable to open PDF"}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)} data-testid="pdf-viewer">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <ToolbarButton label="Previous page" onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1}>
          <ChevronLeft className="h-4 w-4" />
        </ToolbarButton>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            max={pageCount || 1}
            value={pageNumber}
            onChange={(event) => goToPage(Number(event.target.value) || 1)}
            className="h-11 w-16 text-center"
            aria-label="Page number"
          />
          <span className="text-sm text-muted-foreground">/ {pageCount || "—"}</span>
        </div>
        <ToolbarButton label="Next page" onClick={() => goToPage(pageNumber + 1)} disabled={pageNumber >= pageCount}>
          <ChevronRight className="h-4 w-4" />
        </ToolbarButton>

        <div className="mx-1 h-6 w-px bg-border" />

        <ToolbarButton label="Zoom out" onClick={() => zoomBy(-ZOOM_STEP)}>
          <ZoomOut className="h-4 w-4" />
        </ToolbarButton>
        <span className="min-w-14 text-center text-sm text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <ToolbarButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
          <ZoomIn className="h-4 w-4" />
        </ToolbarButton>
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-3 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => {
            setZoomMode("fit-width");
            void paintPage(pageNumber, "fit-width", zoom);
          }}
        >
          Fit width
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-3 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => {
            setZoomMode("fit-page");
            void paintPage(pageNumber, "fit-page", zoom);
          }}
        >
          Fit page
        </Button>

        <div className="mx-1 h-6 w-px bg-border" />

        <ToolbarButton label="Find in document" onClick={() => setFindOpen((open) => !open)}>
          <Search className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton label="Download original" onClick={() => void downloadOriginal()}>
          <Download className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton label="Open source context" onClick={() => setContextOpen((open) => !open)}>
          <ExternalLink className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {findOpen ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Input
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runFind(event.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find in document"
            className="h-11 max-w-sm"
            aria-label="Find in document"
          />
          <Button type="button" variant="outline" className="h-11" onClick={() => void runFind(0)}>
            Find
          </Button>
          <Button type="button" variant="ghost" className="h-11" onClick={() => void runFind(-1)}>
            Previous
          </Button>
          <Button type="button" variant="ghost" className="h-11" onClick={() => void runFind(1)}>
            Next
          </Button>
          {findStatus ? <span className="text-sm text-muted-foreground">{findStatus}</span> : null}
        </div>
      ) : null}

      {contextOpen ? (
        <div className="border-b border-border px-3 py-2 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {sourceContext?.vaultName ? <span>Vault · {sourceContext.vaultName}</span> : null}
            {sourceContext?.filesHref ? (
              <a href={sourceContext.filesHref} className="text-cta hover:text-active">
                Files row
              </a>
            ) : (
              <a href="/files" className="text-cta hover:text-active">
                Files
              </a>
            )}
            {sourceContext?.providerHref ? (
              <a
                href={sourceContext.providerHref}
                target="_blank"
                rel="noreferrer"
                className="text-cta hover:text-active"
              >
                {sourceContext.providerLabel || "Open source"}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-background">
        <div className="relative mx-auto w-fit p-4">
          <canvas ref={canvasRef} className="block bg-card shadow-sm" />
          <div
            ref={textLayerRef}
            className="absolute left-4 top-4 overflow-hidden leading-none text-transparent [&_span]:absolute [&_span]::selection:bg-cta/30"
          />
        </div>
      </div>
    </div>
  );
}
