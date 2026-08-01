import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type ModStatus = "enabled" | "available" | "installing" | "disabling" | "error";

interface ModCatalogEntry {
  key: string;
  name: string;
  description: string;
  outcomeLabel: string;
  outcomePromise: string;
  version: string;
  status: ModStatus;
  resolvedVersion: string | null;
  failureCode: string | null;
  isBaseline: boolean;
  integrations: string[];
}

interface ModsResponse {
  mods: ModCatalogEntry[];
  canManage: boolean;
}

function StatusIcon({ status }: { status: ModStatus }) {
  if (status === "enabled") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (status === "installing" || status === "disabling") return <Loader2 className="h-3.5 w-3.5 animate-spin text-active" />;
  if (status === "error") return <AlertTriangle className="h-3.5 w-3.5 text-error" />;
  return <Boxes className="h-3.5 w-3.5 text-muted-foreground" />;
}

function ModRow({
  mod,
  canManage,
  expanded,
  onToggle,
  onInstall,
  onDisable,
  pending,
}: {
  mod: ModCatalogEntry;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
  onInstall: () => void;
  onDisable: () => void;
  pending: boolean;
}) {
  const busy = pending || mod.status === "installing" || mod.status === "disabling";
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
        data-testid={`mod-row-${mod.key}`}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <StatusIcon status={mod.status} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{mod.name}</span>
        {mod.isBaseline && <span className="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground">Default</span>}
        <span className="shrink-0 text-xs text-muted-foreground">{mod.status === "enabled" ? "Enabled" : mod.status === "error" ? "Error" : "Available"}</span>
      </button>

      {expanded && (
        <div className="ml-6 space-y-3 border-l border-border/40 py-2 pl-3 pr-2">
          <p className="text-sm text-muted-foreground">{mod.outcomePromise}</p>
          {mod.integrations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Integrations: <span className="text-foreground">{mod.integrations.join(", ")}</span>
            </p>
          )}
          {mod.status === "error" && mod.failureCode && (
            <p className="text-xs text-error">Setup failed: {mod.failureCode}. Reinstall to repair.</p>
          )}
          {canManage && (
            <div className="flex items-center gap-2">
              {mod.status === "enabled" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={onDisable} data-testid={`mod-disable-${mod.key}`}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disable"}
                </Button>
              ) : (
                <Button size="sm" className="bg-cta text-cta-foreground hover:bg-cta/90" disabled={busy} onClick={onInstall} data-testid={`mod-install-${mod.key}`}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mod.status === "error" ? `Reinstall ${mod.name}` : `Install ${mod.name}`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ModsPage() {
  usePageHeader({ title: "Mods" });
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<ModCatalogEntry | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ModsResponse>({ queryKey: ["/api/mods"] });

  const mutate = useMutation({
    mutationFn: async ({ key, action }: { key: string; action: "install" | "reinstall" | "disable" }) => {
      const res = await apiRequest("POST", `/api/mods/${key}/${action}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mods"] }),
    onError: (error: Error) => toast({ title: "Could not update Mod", description: error.message, variant: "destructive" }),
    onSettled: () => setPendingKey(null),
  });

  const run = (key: string, action: "install" | "reinstall" | "disable") => {
    setPendingKey(key);
    mutate.mutate({ key, action });
  };

  const mods = data?.mods ?? [];
  const canManage = data?.canManage ?? false;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mods;
    return mods.filter((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.outcomeLabel.toLowerCase().includes(q));
  }, [mods, query]);

  const enabled = filtered.filter((m) => m.status === "enabled");
  const available = filtered.filter((m) => m.status !== "enabled");

  const section = (label: string, items: ModCatalogEntry[]) => (
    <div className="space-y-1">
      <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No {label.toLowerCase()} Mods.</div>
      ) : (
        items.map((mod) => (
          <ModRow
            key={mod.key}
            mod={mod}
            canManage={canManage}
            expanded={expanded === mod.key}
            onToggle={() => setExpanded((cur) => (cur === mod.key ? null : mod.key))}
            onInstall={() => run(mod.key, mod.status === "error" ? "reinstall" : "install")}
            onDisable={() => setConfirmDisable(mod)}
            pending={pendingKey === mod.key}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="w-full p-4 md:w-1/3">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Mods" className="pl-8" data-testid="mods-search" />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-error">
          <span className="min-w-0 flex-1">Mods couldn’t load.</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-2 py-1 text-cta hover:text-active"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Retry"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {section("Enabled", enabled)}
          {section("Available", available)}
        </div>
      )}

      <AlertDialog open={confirmDisable !== null} onOpenChange={(open) => !open && setConfirmDisable(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {confirmDisable?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {confirmDisable?.name}'s surfaces and stops its managed automation immediately. Your data, references, and connected accounts are preserved, and you can reinstall it anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDisable) run(confirmDisable.key, "disable");
                setConfirmDisable(null);
              }}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
