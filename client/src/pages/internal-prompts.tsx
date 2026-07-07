import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  FileText,
  History,
  Loader2,
  RotateCcw,
  Save,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { PromptModule, PromptModuleStatus, PromptModuleVersion } from "@shared/models/prompt-modules";

const ALL = "all";
const STATUSES: Array<PromptModuleStatus | typeof ALL> = [ALL, "active", "draft", "deprecated"];

type PromptModuleMetadata = {
  ownerSystem?: string;
  callSites?: Array<{ file: string; symbol?: string; purpose: string }>;
  manifestDescription?: string;
  activity?: string;
};

type PromptModuleWithManifest = PromptModule & { metadata: PromptModuleMetadata };

type EditablePromptModule = Pick<PromptModule, "name" | "description" | "domain" | "status" | "version" | "prompt" | "outputSpec">;

function moduleToEdit(module: PromptModule): EditablePromptModule {
  return {
    name: module.name,
    description: module.description || "",
    domain: module.domain || "other",
    status: module.status as PromptModuleStatus,
    version: module.version || "1.0",
    prompt: module.prompt || "",
    outputSpec: module.outputSpec || "",
  };
}

function formatUpdatedAt(value: Date | string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDistanceToNow(date, { addSuffix: true });
}

function statusClass(status: string) {
  if (status === "active") return "border-success/40 bg-success/10 text-success";
  if (status === "draft") return "border-info/40 bg-info/10 text-info";
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

function PromptModuleList({
  groupedModules,
  selectedId,
  onSelect,
  loading,
}: {
  groupedModules: Array<[string, PromptModuleWithManifest[]]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full rounded" />)}
      </div>
    );
  }

  if (groupedModules.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-muted-foreground">
        <FileText className="mb-3 h-6 w-6" />
        <p className="text-sm font-medium text-foreground">No prompt modules</p>
        <p className="mt-1 text-xs">Try a different filter.</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {groupedModules.map(([group, groupModules]) => (
        <div key={group} className="pb-2">
          <div className="sticky top-0 z-10 border-y border-border/60 bg-background/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group}
          </div>
          {groupModules.map((module) => (
            <button
              key={module.id}
              onClick={() => onSelect(module.id)}
              className={cn(
                "w-full px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
                selectedId === module.id && "bg-accent",
              )}
              data-testid={`button-prompt-module-${module.id}`}
            >
              <div className="flex items-center gap-2">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{module.key}</span>
                <Badge variant="outline" className={cn("text-[10px] capitalize", statusClass(module.status))}>{module.status}</Badge>
              </div>
              <div className="mt-1 truncate pl-5 text-xs text-muted-foreground">{module.name}</div>
              <div className="mt-1 flex items-center gap-2 pl-5 text-xs text-muted-foreground/70">
                <span>{module.metadata?.ownerSystem || module.domain}</span>
                <span>{module.metadata?.callSites?.length || 0} call sites</span>
                <span>v{module.version}</span>
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function VersionHistory({
  module,
  versions,
  loading,
  onRestore,
  restoring,
}: {
  module: PromptModuleWithManifest;
  versions: PromptModuleVersion[];
  loading: boolean;
  onRestore: (version: PromptModuleVersion) => void;
  restoring: boolean;
}) {
  return (
    <Card className="min-h-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          Version history
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-64">
          {loading ? (
            <div className="space-y-2 p-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full rounded" />)}
            </div>
          ) : versions.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">No prior versions yet.</div>
          ) : (
            <div className="divide-y divide-border/50">
              {versions.map((version) => (
                <div key={version.id} className="flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">v{version.version}</span>
                      <Badge variant="outline" className={cn("text-[10px] capitalize", statusClass(version.status))}>{version.status}</Badge>
                      {version.id && <span className="text-xs text-muted-foreground">#{version.id}</span>}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatUpdatedAt(version.createdAt)}</div>
                    {version.changeNote && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{version.changeNote}</div>}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0"
                    onClick={() => onRestore(version)}
                    disabled={restoring || version.prompt === module.prompt && version.outputSpec === module.outputSpec && version.version === module.version}
                    data-testid={`button-restore-prompt-version-${version.id}`}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export default function InternalPromptsTab() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState(ALL);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>(ALL);
  const [draft, setDraft] = useState<EditablePromptModule | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<PromptModuleVersion | null>(null);

  const { data: modules = [], isLoading } = useQuery<PromptModuleWithManifest[]>({
    queryKey: ["/api/prompt-modules"],
  });

  const domains = useMemo(() => {
    const values = Array.from(new Set(modules.map((m) => m.domain || "other"))).sort((a, b) => a.localeCompare(b));
    return [ALL, ...values];
  }, [modules]);

  const filteredModules = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules.filter((module) => {
      if (domain !== ALL && module.domain !== domain) return false;
      if (status !== ALL && module.status !== status) return false;
      if (!q) return true;
      return [module.key, module.name, module.description, module.sourceSkillName || "", module.metadata?.ownerSystem || "", ...(module.metadata?.callSites || []).map((site) => `${site.file} ${site.symbol || ""} ${site.purpose}`)]
        .some((value) => value.toLowerCase().includes(q));
    });
  }, [modules, query, domain, status]);

  const selected = modules.find((m) => m.id === selectedId) || filteredModules[0] || null;

  const groupedModules = useMemo(() => {
    const groups = new Map<string, PromptModuleWithManifest[]>();
    for (const module of filteredModules) {
      const group = module.domain || "other";
      const list = groups.get(group) || [];
      list.push(module);
      groups.set(group, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredModules]);

  useEffect(() => {
    if (!selectedId && filteredModules[0]) setSelectedId(filteredModules[0].id);
    if (selectedId && !filteredModules.some((m) => m.id === selectedId)) setSelectedId(filteredModules[0]?.id ?? null);
  }, [filteredModules, selectedId]);

  useEffect(() => {
    setDraft(selected ? moduleToEdit(selected) : null);
  }, [selected?.id, selected?.updatedAt]);

  const { data: versions = [], isLoading: versionsLoading } = useQuery<PromptModuleVersion[]>({
    queryKey: ["/api/prompt-modules", selected?.id, "versions"],
    queryFn: async () => {
      if (!selected) return [];
      const res = await fetch(`/api/prompt-modules/${selected.id}/versions`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: !!selected,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !draft) throw new Error("No prompt selected");
      const res = await apiRequest("PATCH", `/api/prompt-modules/${selected.id}`, {
        ...draft,
        changeNote: "edited from Build internal prompts UI",
      });
      return res.json() as Promise<PromptModule>;
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules", updated.id, "versions"] });
      setSelectedId(updated.id);
      toast({ title: "Prompt module saved" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const restoreMutation = useMutation({
    mutationFn: async (version: PromptModuleVersion) => {
      if (!selected) throw new Error("No prompt selected");
      const res = await apiRequest("POST", `/api/prompt-modules/${selected.id}/restore/${version.id}`);
      return res.json() as Promise<PromptModule>;
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules", updated.id, "versions"] });
      setRestoreTarget(null);
      setSelectedId(updated.id);
      toast({ title: "Prompt module restored" });
    },
    onError: (err: Error) => toast({ title: "Restore failed", description: err.message, variant: "destructive" }),
  });

  const dirty = !!selected && !!draft && JSON.stringify(moduleToEdit(selected)) !== JSON.stringify(draft);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="internal-prompts-tab">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            <div className="flex items-center gap-2 font-medium"><AlertCircle className="h-3.5 w-3.5" /> Internal prompts are not runnable skills.</div>
            <p className="mt-1 text-warning/80">They are DB-backed templates consumed by code call sites. Execution stays in workflows and model clients.</p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter prompts..." className="h-8 pl-8 text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Domain" /></SelectTrigger>
              <SelectContent>{domains.map((value) => <SelectItem key={value} value={value}>{value === ALL ? "All domains" : value}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>{STATUSES.map((value) => <SelectItem key={value} value={value}>{value === ALL ? "All statuses" : value}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <PromptModuleList groupedModules={groupedModules} selectedId={selected?.id ?? null} onSelect={setSelectedId} loading={isLoading} />
        </ScrollArea>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-4">
        {!selected || !draft ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <FileText className="mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">Select a prompt module to edit</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-xl">{selected.name}</CardTitle>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{selected.key}</span>
                      <Badge variant="outline" className={cn("capitalize", statusClass(selected.status))}>{selected.status}</Badge>
                      <span>v{selected.version}</span>
                      <span>Updated {formatUpdatedAt(selected.updatedAt)}</span>
                      {selected.sourceSkillName && <span>Source skill: <span className="font-mono">{selected.sourceSkillName}</span></span>}
                    </div>
                  </div>
                  <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending || !draft.name.trim() || !draft.prompt.trim()} data-testid="button-save-prompt-module">
                    {saveMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                    Save
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Name</Label>
                    <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1.5">
                      <Label>Domain</Label>
                      <Input value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select value={draft.status} onValueChange={(value) => setDraft({ ...draft, status: value as PromptModuleStatus })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{STATUSES.filter((s) => s !== ALL).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Version</Label>
                      <Input value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="min-h-20" />
                </div>
                <div className="rounded-md border border-border bg-muted/25 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Boxes className="h-4 w-4" /> Used by</div>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="capitalize">{selected.metadata?.ownerSystem || selected.domain}</Badge>
                    {selected.metadata?.activity && <span>Activity: <span className="font-mono">{selected.metadata.activity}</span></span>}
                  </div>
                  {selected.metadata?.callSites?.length ? (
                    <div className="space-y-2">
                      {selected.metadata.callSites.map((site, index) => (
                        <div key={`${site.file}-${site.symbol || index}`} className="rounded border border-border/60 bg-background/60 p-2 text-xs">
                          <div className="font-mono text-foreground">{site.file}{site.symbol ? ` · ${site.symbol}` : ""}</div>
                          <div className="mt-1 text-muted-foreground">{site.purpose}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No manifest call sites registered. Treat this as orphan-risk until the registry is updated.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>Prompt text</Label>
                  <Textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className="min-h-[420px] font-mono text-xs leading-relaxed" />
                </div>
                <div className="space-y-1.5">
                  <Label>Output spec</Label>
                  <Textarea value={draft.outputSpec} onChange={(e) => setDraft({ ...draft, outputSpec: e.target.value })} className="min-h-40 font-mono text-xs leading-relaxed" />
                </div>
                {dirty && (
                  <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Unsaved changes
                  </div>
                )}
                {!dirty && (
                  <div className="flex items-center gap-2 rounded-md border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Saved
                  </div>
                )}
              </CardContent>
            </Card>

            <VersionHistory module={selected} versions={versions} loading={versionsLoading} onRestore={setRestoreTarget} restoring={restoreMutation.isPending} />
          </div>
        )}
      </main>

      <Dialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore prior prompt version?</DialogTitle>
            <DialogDescription>
              This replaces the current prompt text, output spec, status, and metadata with version #{restoreTarget?.id}. The current version is snapshotted first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>Cancel</Button>
            <Button onClick={() => restoreTarget && restoreMutation.mutate(restoreTarget)} disabled={restoreMutation.isPending}>
              {restoreMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1.5 h-4 w-4" />}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
