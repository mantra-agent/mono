import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Database,
  Loader2,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";

const log = createLogger("VaultMigrationControls");
const MIGRATION_KEY = ["/api/vaults/migration"] as const;

interface VaultMigrationStatus {
  status: "idle" | "analyzing" | "ready" | "running" | "completed" | "failed";
  destination: { accountId: string; vaultId: string; name: string } | null;
  counts: {
    scanned: number;
    eligible: number;
    excluded: number;
    oversized: number;
    verified: number;
    copied: number;
    existing: number;
    errors: number;
    unresolved: number;
  };
  analysisFingerprint: string | null;
  lastProcessedKey: string | null;
  lastError: string | null;
  analyzedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

function statusLabel(status: VaultMigrationStatus["status"]): string {
  const labels: Record<VaultMigrationStatus["status"], string> = {
    idle: "Not analyzed",
    analyzing: "Analyzing",
    ready: "Ready",
    running: "Migrating",
    completed: "Verified",
    failed: "Needs attention",
  };
  return labels[status];
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function StartMigrationDialog({
  open,
  onOpenChange,
  migration,
  onStart,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  migration: VaultMigrationStatus;
  onStart: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start R2 migration</DialogTitle>
          <DialogDescription>
            Copy {migration.counts.eligible.toLocaleString()} eligible legacy object{migration.counts.eligible === 1 ? "" : "s"} into the {migration.destination?.name ?? "Personal"} vault and verify every copy. Existing legacy objects and references will remain unchanged.
          </DialogDescription>
        </DialogHeader>
        {migration.counts.excluded > 0 && (
          <p className="text-sm text-muted-foreground">
            {migration.counts.excluded.toLocaleString()} backup or inference object{migration.counts.excluded === 1 ? " is" : "s are"} excluded.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onStart} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Start migration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VaultMigrationControls() {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  const migrationQuery = useQuery<VaultMigrationStatus>({
    queryKey: MIGRATION_KEY,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "analyzing" || status === "running" ? 1_000 : false;
    },
  });

  const updateMigration = (next: VaultMigrationStatus) => {
    queryClient.setQueryData(MIGRATION_KEY, next);
  };

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/vaults/migration/analyze");
      return response.json() as Promise<VaultMigrationStatus>;
    },
    onSuccess: (next) => {
      updateMigration(next);
      setOpen(true);
      if (next.status === "ready") {
        toast({ title: "Migration analyzed", description: `${next.counts.eligible.toLocaleString()} objects are ready to copy.` });
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to analyze migration";
      log.error("analyze migration failed", { error: message });
      queryClient.invalidateQueries({ queryKey: MIGRATION_KEY });
      toast({ title: "Migration analysis failed", description: message, variant: "destructive" });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/vaults/migration/start");
      return response.json() as Promise<VaultMigrationStatus>;
    },
    onSuccess: (next) => {
      updateMigration(next);
      setConfirmOpen(false);
      setOpen(true);
      if (next.status === "completed") {
        toast({ title: "Migration verified", description: `${next.counts.verified.toLocaleString()} objects verified in the Personal vault.` });
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to start migration";
      log.error("start migration failed", { error: message });
      setConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: MIGRATION_KEY });
      toast({ title: "Migration failed", description: message, variant: "destructive" });
    },
  });

  if (migrationQuery.isLoading) {
    return (
      <div className="flex items-center px-2 py-1.5 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading migration status
      </div>
    );
  }

  if (migrationQuery.isError || !migrationQuery.data) {
    const message = migrationQuery.error instanceof Error ? migrationQuery.error.message : "Migration status is unavailable";
    return (
      <div className="space-y-2 px-2 py-1.5">
        <div className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => migrationQuery.refetch()}>Retry</Button>
      </div>
    );
  }

  const migration = migrationQuery.data;
  const isActive = migration.status === "analyzing" || migration.status === "running";
  const canStart = migration.status === "ready" && migration.counts.unresolved === 0;
  const hasAnalysis = migration.status !== "idle";
  const progress = migration.counts.eligible > 0
    ? Math.min(100, Math.round((migration.counts.verified / migration.counts.eligible) * 100))
    : migration.status === "completed" ? 100 : 0;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-center rounded-md hover:bg-accent/70">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
            <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">Legacy R2 migration</span>
            <span className={`shrink-0 text-xs ${migration.status === "failed" ? "text-destructive" : migration.status === "running" || migration.status === "analyzing" ? "text-active" : "text-muted-foreground"}`}>
              {statusLabel(migration.status)}
            </span>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="sm"
            className="mr-1 h-8 shrink-0 px-2 text-cta hover:text-cta/80"
            onClick={() => {
              setOpen(true);
              analyzeMutation.mutate();
            }}
            disabled={isActive || analyzeMutation.isPending || startMutation.isPending}
          >
            {(migration.status === "analyzing" || analyzeMutation.isPending) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1.5 h-3.5 w-3.5" />}
            {hasAnalysis ? "Analyze again" : "Analyze"}
          </Button>
        </div>
        <CollapsibleContent>
          <div className="ml-6 min-w-0 space-y-3 border-l border-border/40 py-2 pl-4 pr-2">
            <p className="text-sm text-muted-foreground">
              Copies eligible legacy objects into the admin Personal vault. Legacy objects and references remain in place.
            </p>

            {hasAnalysis && migration.destination && (
              <div className="min-w-0">
                <Stat label="Destination" value={migration.destination.name} />
                <Stat label="Scanned" value={migration.counts.scanned.toLocaleString()} />
                <Stat label="Eligible" value={migration.counts.eligible.toLocaleString()} />
                <Stat label="Excluded" value={migration.counts.excluded.toLocaleString()} />
                {migration.counts.oversized > 0 && <Stat label="Over 5 GB" value={migration.counts.oversized.toLocaleString()} />}
                {(migration.status === "running" || migration.status === "completed" || migration.counts.verified > 0) && (
                  <>
                    <Stat label="Verified" value={`${migration.counts.verified.toLocaleString()} / ${migration.counts.eligible.toLocaleString()}`} />
                    <Stat label="Copied" value={migration.counts.copied.toLocaleString()} />
                    <Stat label="Already present" value={migration.counts.existing.toLocaleString()} />
                  </>
                )}
                {migration.counts.unresolved > 0 && <Stat label="Unresolved" value={migration.counts.unresolved.toLocaleString()} />}
              </div>
            )}

            {migration.status === "running" && (
              <div className="space-y-1.5" aria-label={`Migration ${progress}% complete`}>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-active transition-all" style={{ width: `${progress}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">{progress}% verified</p>
              </div>
            )}

            {migration.status === "completed" && (
              <div className="flex items-start gap-2 text-sm text-success">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>All {migration.counts.verified.toLocaleString()} eligible objects are verified in the Personal vault.</span>
              </div>
            )}

            {(migration.status === "failed" || migration.counts.errors > 0) && (
              <div className="flex min-w-0 items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{migration.lastError ?? `${migration.counts.unresolved.toLocaleString()} objects remain unresolved.`}</span>
              </div>
            )}

            {canStart && (
              <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={startMutation.isPending}>
                Start migration
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <StartMigrationDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        migration={migration}
        onStart={() => startMutation.mutate()}
        isPending={startMutation.isPending}
      />
    </>
  );
}
