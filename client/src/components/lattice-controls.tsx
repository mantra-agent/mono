// Shared morphogenic-lattice UI grammar for editable platform defaults.
//
// One motif, reused by both the Personas page and the Skills page: a green
// inbound "default advanced" mark, an amber "edited locally" mark, a
// current-vs-default diff view, an Apply/Revert-to-default confirmation, and the
// inbound Keep-mine / Use-updated-default acknowledgement row. Persona- and
// Skill-specific payload builders live in their own pages; everything that is
// payload-agnostic lives here so the two catalogs cannot drift into a second
// motif.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
import { useToast } from "@/hooks/use-toast";

export interface ApplyDiffRow {
  field: string;
  before: string;
  after: string;
}

export type DefaultSyncMode = "apply" | "revert";

export interface PendingSync {
  mode: DefaultSyncMode;
  title: string;
  description: string;
  rows: ApplyDiffRow[];
  run: () => Promise<void>;
}

/** A small status dot: green = default advanced (inbound), amber = edited locally. */
export function StatusDot({ kind, className }: { kind: "local" | "inbound"; className?: string }) {
  const inbound = kind === "inbound";
  return (
    <Circle
      className={cn(
        "h-1.5 w-1.5",
        inbound ? "fill-success text-success" : "fill-warning text-warning",
        className,
      )}
      aria-label={inbound ? "Default has advanced" : "Edited locally"}
    />
  );
}

/** Render any payload value as a stable, human-readable diff string. */
export function formatDiffValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.trim() ? value : "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) {
      return value.map(String).join(", ");
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Compute the changed-field diff rows between two payloads, using a label map. */
export function buildDiffRows(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  labelFor: (field: string) => string,
): ApplyDiffRow[] {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).sort();
  return keys
    .map((field) => {
      const left = formatDiffValue(before?.[field]);
      const right = formatDiffValue(after?.[field]);
      if (left === right) return null;
      return { field: labelFor(field), before: left, after: right };
    })
    .filter((row): row is ApplyDiffRow => row != null);
}

export function ApplyDiffView({ rows, mode }: { rows: ApplyDiffRow[]; mode: DefaultSyncMode }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No differences from the current default.</p>;
  }
  const leftLabel = mode === "revert" ? "Current" : "Current default";
  const rightLabel = mode === "revert" ? "After revert" : "After apply";
  return (
    <div className="max-h-80 space-y-2 overflow-auto pr-1">
      {rows.map((row) => (
        <div key={row.field} className="rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="mb-1 text-xs font-medium text-foreground">{row.field}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{leftLabel}</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-muted-foreground">{row.before}</pre>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{rightLabel}</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 text-xs text-foreground">{row.after}</pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Apply a payload (or one field) to its platform default, or revert it, behind a confirmation prompt. */
export function useDefaultSync(onDone: () => void) {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingSync | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: PendingSync) => {
      await input.run();
    },
    onSuccess: (_data, input) => {
      toast({ title: input.mode === "revert" ? "Reverted to default" : "Applied to default" });
      setPending(null);
      onDone();
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update default", description: err.message, variant: "destructive" });
    },
  });
  const request = (build: () => PendingSync) => {
    try {
      setPending(build());
    } catch (err) {
      toast({ title: "Can't continue", description: (err as Error).message, variant: "destructive" });
    }
  };
  return {
    pending,
    request,
    cancel: () => setPending(null),
    confirm: () => {
      if (pending) mutation.mutate(pending);
    },
    working: mutation.isPending,
  };
}

export function DefaultSyncDialog({ sync }: { sync: ReturnType<typeof useDefaultSync> }) {
  const mode: DefaultSyncMode = sync.pending?.mode ?? "apply";
  return (
    <AlertDialog open={sync.pending != null} onOpenChange={(o) => { if (!o) sync.cancel(); }}>
      <AlertDialogContent className="max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{sync.pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>{sync.pending?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ApplyDiffView rows={sync.pending?.rows || []} mode={mode} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={sync.working || (sync.pending?.rows.length ?? 0) === 0} onClick={(event) => { event.preventDefault(); sync.confirm(); }}>
            {sync.working ? "Working…" : mode === "revert" ? "Revert to default" : "Apply to default"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Inbound acknowledgement row: accept the advanced default or stay customized. */
export function UpdateAvailableActions({
  onKeepMine,
  onUseUpdatedDefault,
  working,
}: {
  onKeepMine: () => void;
  onUseUpdatedDefault: () => void;
  working?: boolean;
}) {
  return (
    <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-default")}>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">Update available</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={working} onClick={onKeepMine}>Keep mine</Button>
          <Button size="sm" disabled={working} onClick={onUseUpdatedDefault}>Use updated default</Button>
        </div>
      </div>
    </div>
  );
}
