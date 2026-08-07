import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { usePageHeader } from "@/hooks/use-page-header";
import { PdfViewer, type PdfOpenSource, type PdfViewerSourceContext } from "@/components/pdf/pdf-viewer";

function firstQueryValue(key: string): string | null {
  const value = new URLSearchParams(window.location.search).get(key);
  return value && value.trim() ? value.trim() : null;
}

export default function DocumentViewerPage() {
  const [, params] = useRoute("/documents/:id");
  const id = params?.id ?? "";
  const [title, setTitle] = useState("Document");

  usePageHeader({ title });

  const source = useMemo<PdfOpenSource | null>(() => {
    if (!id) return null;
    const kind = firstQueryValue("source") ?? "document";
    if (kind === "drive_resource") {
      return {
        kind: "drive_resource",
        driveResourceId: id,
        vaultId: firstQueryValue("vaultId") ?? undefined,
      };
    }
    if (kind === "provider") {
      const provider = firstQueryValue("provider");
      const vaultId = firstQueryValue("vaultId");
      if (
        (provider === "google" || provider === "box" || provider === "mantra") &&
        vaultId
      ) {
        return {
          kind: "provider",
          provider,
          providerFileId: id,
          vaultId,
          rootDriveResourceId: firstQueryValue("rootDriveResourceId") ?? undefined,
        };
      }
      return null;
    }
    if (kind === "object") {
      return { kind: "object", objectPath: id };
    }
    return { kind: "document", documentId: id };
  }, [id]);

  const sourceContext = useMemo<PdfViewerSourceContext>(() => {
    return {
      vaultName: firstQueryValue("vaultName"),
      filesHref: "/files",
      providerLabel: firstQueryValue("providerLabel"),
      providerHref: firstQueryValue("providerHref"),
    };
  }, [id]);

  if (!source) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-4">
        <p className="text-sm text-destructive">Document not found</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="document-viewer-page">
      <PdfViewer source={source} onTitle={setTitle} sourceContext={sourceContext} className="min-h-0 flex-1" />
    </div>
  );
}
