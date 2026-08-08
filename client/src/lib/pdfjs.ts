/**
 * Single PDF.js load boundary for the Core PDF viewer.
 *
 * Package dependency is declared as pdfjs-dist@6.2.108. Vite emits the matching
 * renderer and worker from that installed package so one application build owns
 * the complete worker-backed path.
 */

import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

export const PDFJS_VERSION = "6.2.108" as const;

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
  // The application build owns both halves of the PDF.js contract. Runtime CDN
  // imports make document availability depend on a third-party origin and can
  // pair a cached renderer with a different worker response.
  const bundled = await import("pdfjs-dist/build/pdf.mjs");
  return bundled as unknown as PdfJsModule;
}

export function pdfWorkerSrc(): string {
  return pdfWorkerUrl;
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
