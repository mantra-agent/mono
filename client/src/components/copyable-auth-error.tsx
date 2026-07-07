import { useState } from "react";
import { Copy, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyableAuthErrorState {
  title: string;
  detail?: string;
}

function formatAuthError(error: CopyableAuthErrorState): string {
  return [error.title, error.detail].filter(Boolean).join("\n");
}

export function CopyableAuthError({ error, onDismiss }: { error: CopyableAuthErrorState | null; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!error) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formatAuthError(error));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="auth-error-title"
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 id="auth-error-title" className="text-base font-semibold text-destructive">
              {error.title}
            </h2>
            {error.detail && (
              <p className="break-words text-sm leading-relaxed text-muted-foreground">
                {error.detail}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onDismiss}
            aria-label="Dismiss error"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={cn(copied && "text-success")}
          >
            <Copy className="mr-2 h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy error"}
          </Button>
          <Button type="button" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
