/**
 * Single PDF.js load boundary for the Core PDF viewer.
 *
 * Package dependency is declared as pdfjs-dist@6.2.108. The browser loads the
 * matching official ESM build + worker so there is exactly one renderer version
 * and one worker-backed path.
 */

export const PDFJS_VERSION = "6.2.108" as const;
const PDFJS_CDN_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

export type PdfJsModule = {
  getDocument: (src: unknown) => { promise: Promise<PdfJsDocument> };
  GlobalWorkerOptions: { workerSrc: string };
  TextLayer?: {
    render: (params: {
      textContentSource: unknown;
      container: HTMLElement;
      viewport: PdfJsViewport;
    }) => { promise: Promise<void> };
  };
};

export type PdfJsViewport = {
  width: number;
  height: number;
  scale: number;
  clone: (options: { scale: number }) => PdfJsViewport;
};

export type PdfJsPage = {
  getViewport: (params: { scale: number }) => PdfJsViewport;
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfJsViewport;
    canvas: HTMLCanvasElement;
  }) => { promise: Promise<void>; cancel: () => void };
  getTextContent: () => Promise<unknown>;
};

export type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  destroy: () => Promise<void> | void;
  getData?: () => Promise<Uint8Array>;
};

let loadPromise: Promise<PdfJsModule> | null = null;

async function importPdfJs(): Promise<PdfJsModule> {
  // Load the exact package version declared in package.json / package-lock.
  // Runtime URL import keeps the session build independent of shared node_modules
  // while still pinning Mozilla PDF.js as the sole renderer.
  const moduleUrl = `${PDFJS_CDN_BASE}/build/pdf.mjs`;
  const remote = await import(/* @vite-ignore */ moduleUrl);
  return remote as unknown as PdfJsModule;
}

export function pdfWorkerSrc(): string {
  return `${PDFJS_CDN_BASE}/build/pdf.worker.mjs`;
}

export function loadPdfJs(): Promise<PdfJsModule> {
  if (!loadPromise) {
    loadPromise = importPdfJs().then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc();
      return pdfjs;
    });
  }
  return loadPromise;
}
