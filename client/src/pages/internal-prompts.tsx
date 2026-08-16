import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { PromptModule, PromptModuleStatus, PromptModuleVersion } from "@shared/models/prompt-modules";

const STATUSES: PromptModuleStatus[] = ["active", "draft", "deprecated"];

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

function invalidatePrompt(id?: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules"] });
  if (id) queryClient.invalidateQueries({ queryKey: ["/api/prompt-modules", id, "versions"] });
}

export default function PromptsPage() {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: modules = [], isLoading } = useQuery<PromptModuleWithManifest[]>({
    queryKey: ["/api/prompt-modules"],
  });

  const filteredModules = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return modules;
    return modules.filter((module) =>
      [
        module.key,
        module.name,
        module.description,
        module.status,
        module.version,
        module.sourceSkillName || "",
        module.metadata?.ownerSystem || "",
        ...(module.metadata?.callSites || []).map((site) => `${site.file} ${site.symbol || ""} ${site.purpose}`),
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [modules, search]);

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

  return (
    <div className="min-w-0 overflow-x-hidden bg-background text-foreground" data-testid="internal-prompts-tab">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId="input-search-prompts"
          clearTestId="button-clear-prompt-search"
          ariaLabel="Search prompts"
        />
        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading prompts…</div>
        ) : groupedModules.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            {search.trim() ? `No prompts match "${search.trim()}".` : "No prompt modules."}
          </div>
        ) : (
          groupedModules.map(([group, items]) => (
            <PromptSection
              key={group}
              label={group}
              items={items}
              openId={openId}
              setOpenId={setOpenId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PromptSection({
  label,
  items,
  openId,
  setOpenId,
}: {
  label: string;
  items: PromptModuleWithManifest[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
        data-testid={`button-group-${label.toLowerCase()}`}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} · {items.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {items.map((item) => (
          <PromptRow
            key={item.id}
            module={item}
            open={openId === item.id}
            onToggle={() => setOpenId(openId === item.id ? null : item.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PromptRow({
  module,
  open,
  onToggle,
}: {
  module: PromptModuleWithManifest;
  open: boolean;
  onToggle: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<EditablePromptModule>(() => moduleToEdit(module));
  const [restoreTarget, setRestoreTarget] = useState<PromptModuleVersion | null>(null);

  useEffect(() => {
    setDraft(moduleToEdit(module));
  }, [module.id, module.updatedAt]);

  const { data: versions = [], isLoading: versionsLoading } = useQuery<PromptModuleVersion[]>({
    queryKey: ["/api/prompt-modules", module.id, "versions"],
    queryFn: async () => {
      const res = await fetch(`/api/prompt-modules/${module.id}/versions`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: open,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/prompt-modules/${module.id}`, {
        ...draft,
        changeNote: "edited from Build internal prompts UI",
      });
      return res.json() as Promise<PromptModule>;
    },
    onSuccess: (updated) => {
      invalidatePrompt(updated.id);
      toast({ title: "Prompt module saved" });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const restoreMutation = useMutation({
    mutationFn: async (version: PromptModuleVersion) => {
      const res = await apiRequest("POST", `/api/prompt-modules/${module.id}/restore/${version.id}`);
      return res.json() as Promise<PromptModule>;
    },
    onSuccess: (updated) => {
      invalidatePrompt(updated.id);
      setRestoreTarget(null);
      toast({ title: "Prompt module restored" });
    },
    onError: (err: Error) => toast({ title: "Restore failed", description: err.message, variant: "destructive" }),
  });

  const dirty = JSON.stringify(moduleToEdit(module)) !== JSON.stringify(draft);

  return (
    <div data-testid={`tree-prompt-${module.id}`}>
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "min-w-0 hover:bg-accent/70",
          open && "bg-accent text-foreground",
        )}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        data-testid={`button-prompt-module-${module.id}`}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{module.key}</span>
        <span className="hidden min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground sm:block">{module.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">v{module.version}</span>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
            aria-label={open ? "Collapse prompt" : "Expand prompt"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
        </span>
      </div>
      {open && (
        <PromptEditor
          module={module}
          draft={draft}
          dirty={dirty}
          saving={saveMutation.isPending}
          versions={versions}
          versionsLoading={versionsLoading}
          restoring={restoreMutation.isPending}
          onChange={setDraft}
          onSave={() => saveMutation.mutate()}
          onRestore={setRestoreTarget}
        />
      )}
      <AlertDialog open={!!restoreTarget} onOpenChange={(next) => !next && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore prior prompt version?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the current prompt text, output spec, status, and metadata with version #{restoreTarget?.id}. The current version is snapshotted first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restoreMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (restoreTarget) restoreMutation.mutate(restoreTarget);
              }}
            >
              {restoreMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1.5 h-4 w-4" />}
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PromptEditor({
  module,
  draft,
  dirty,
  saving,
  versions,
  versionsLoading,
  restoring,
  onChange,
  onSave,
  onRestore,
}: {
  module: PromptModuleWithManifest;
  draft: EditablePromptModule;
  dirty: boolean;
  saving: boolean;
  versions: PromptModuleVersion[];
  versionsLoading: boolean;
  restoring: boolean;
  onChange: (draft: EditablePromptModule) => void;
  onSave: () => void;
  onRestore: (version: PromptModuleVersion) => void;
}) {
  const callSites = module.metadata?.callSites ?? [];
  return (
    <div className="space-y-1 pb-2" data-testid={`tree-prompt-details-${module.id}`}>
      <ProfileDetailSection title="Prompt" defaultOpen>
        <ProfileTreeRow label="Key" hasValue showEmpty mobileLayout="inline">
          <span className="font-mono text-sm">{module.key}</span>
        </ProfileTreeRow>
        <ProfileTreeRow label="Name" hasValue showEmpty mobileLayout="inline">
          <Input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            className="h-7 w-56 text-right"
            data-testid="input-prompt-name"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Domain" hasValue showEmpty mobileLayout="inline">
          <Input
            value={draft.domain}
            onChange={(event) => onChange({ ...draft, domain: event.target.value })}
            className="h-7 w-56 text-right"
            data-testid="input-prompt-domain"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Status" hasValue showEmpty mobileLayout="inline">
          <Select value={draft.status} onValueChange={(value) => onChange({ ...draft, status: value as PromptModuleStatus })}>
            <SelectTrigger className="h-7 w-56" data-testid="select-prompt-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileTreeRow>
        <ProfileTreeRow label="Version" hasValue showEmpty mobileLayout="inline">
          <Input
            value={draft.version}
            onChange={(event) => onChange({ ...draft, version: event.target.value })}
            className="h-7 w-56 text-right"
            data-testid="input-prompt-version"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Updated" hasValue showEmpty mobileLayout="inline">
          <span className="text-sm text-muted-foreground">{formatUpdatedAt(module.updatedAt)}</span>
        </ProfileTreeRow>
        {module.sourceSkillName ? (
          <ProfileTreeRow label="Source skill" hasValue showEmpty mobileLayout="inline">
            <span className="font-mono text-sm">{module.sourceSkillName}</span>
          </ProfileTreeRow>
        ) : null}
        <ProfileTreeRow label="Description" hasValue={Boolean(draft.description.trim())} showEmpty mobileLayout="stacked">
          <Textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            className="min-h-20 text-sm"
            data-testid="textarea-prompt-description"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Prompt" hasValue={Boolean(draft.prompt.trim())} showEmpty mobileLayout="stacked">
          <Textarea
            value={draft.prompt}
            onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
            className="min-h-48 font-mono text-xs leading-relaxed"
            data-testid="textarea-prompt-text"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Output spec" hasValue={Boolean(draft.outputSpec.trim())} showEmpty mobileLayout="stacked">
          <Textarea
            value={draft.outputSpec}
            onChange={(event) => onChange({ ...draft, outputSpec: event.target.value })}
            className="min-h-32 font-mono text-xs leading-relaxed"
            data-testid="textarea-prompt-output-spec"
          />
        </ProfileTreeRow>
      </ProfileDetailSection>

      <ProfileDetailSection title="Used by" count={callSites.length} defaultOpen>
        <ProfileTreeRow label="Owner" hasValue showEmpty mobileLayout="inline">
          <span className="text-sm">{module.metadata?.ownerSystem || module.domain}</span>
        </ProfileTreeRow>
        {module.metadata?.activity ? (
          <ProfileTreeRow label="Activity" hasValue showEmpty mobileLayout="inline">
            <span className="font-mono text-sm">{module.metadata.activity}</span>
          </ProfileTreeRow>
        ) : null}
        {callSites.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No manifest call sites registered.</div>
        ) : callSites.map((site, index) => (
          <ProfileTreeRow
            key={`${site.file}-${site.symbol || index}`}
            label={site.symbol || site.file}
            hasValue
            showEmpty
            mobileLayout="stacked"
          >
            <div className="min-w-0 text-right">
              <div className="font-mono text-xs">{site.file}{site.symbol ? ` · ${site.symbol}` : ""}</div>
              <div className="text-xs text-muted-foreground">{site.purpose}</div>
            </div>
          </ProfileTreeRow>
        ))}
      </ProfileDetailSection>

      <ProfileDetailSection title="Versions" count={versions.length} defaultOpen={false}>
        {versionsLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading versions…</div>
        ) : versions.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No prior versions yet.</div>
        ) : versions.map((version) => (
          <ProfileTreeRow
            key={version.id}
            label={`v${version.version}`}
            hasValue
            showEmpty
            mobileLayout="inline"
            actionContent={
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => onRestore(version)}
                disabled={restoring || (version.prompt === module.prompt && version.outputSpec === module.outputSpec && version.version === module.version)}
                data-testid={`button-restore-prompt-version-${version.id}`}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Restore
              </Button>
            }
          >
            <div className="text-right text-xs text-muted-foreground">
              <div>{formatUpdatedAt(version.createdAt)}{version.id ? ` · #${version.id}` : ""}</div>
              {version.changeNote ? <div className="truncate">{version.changeNote}</div> : null}
            </div>
          </ProfileTreeRow>
        ))}
      </ProfileDetailSection>

      <div className="flex items-center justify-end gap-2 px-2 py-1">
        {dirty ? (
          <span className="mr-auto flex items-center gap-1 text-xs text-warning">
            <AlertCircle className="h-3.5 w-3.5" /> Unsaved changes
          </span>
        ) : (
          <span className="mr-auto flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        <Button
          size="sm"
          onClick={onSave}
          disabled={!dirty || saving || !draft.name.trim() || !draft.prompt.trim()}
          data-testid="button-save-prompt-module"
        >
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save
        </Button>
      </div>
    </div>
  );
}
