import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, FileStack, Loader2, Plus } from "lucide-react";
import type { DocumentTemplate } from "@shared/models/document-templates";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface TemplatesResponse {
  templates: DocumentTemplate[];
}

interface TemplateDraft {
  id: string;
  name: string;
  pageId: string;
  pageLabel: string;
}

function mutationErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The template was not saved.";
  const jsonStart = error.message.indexOf("{");
  if (jsonStart === -1) return error.message;
  try {
    const parsed = JSON.parse(error.message.slice(jsonStart)) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : error.message;
  } catch {
    return error.message;
  }
}

function TemplateEditor({
  template,
  onClose,
}: {
  template?: DocumentTemplate;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    template
      ? { id: template.id, name: template.name, pageId: template.pageId, pageLabel: template.pageId }
      : { id: "", name: "", pageId: "", pageLabel: "" },
  );
  const invalidate = () =>
    queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/templates"),
    });

  const pageValue: ReferencePickerValue[] = draft.pageId
    ? [{ type: "page", id: draft.pageId, label: draft.pageLabel || draft.pageId }]
    : [];

  const save = useMutation({
    mutationFn: async () => {
      if (template) {
        return (
          await apiRequest("PATCH", `/api/templates/${template.id}`, {
            name: draft.name.trim(),
            pageId: draft.pageId.trim(),
          })
        ).json() as Promise<DocumentTemplate>;
      }
      return (
        await apiRequest("POST", "/api/templates", {
          id: draft.id.trim(),
          name: draft.name.trim(),
          pageId: draft.pageId.trim(),
        })
      ).json() as Promise<DocumentTemplate>;
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (error) =>
      toast({ title: "Could not save template", description: mutationErrorMessage(error), variant: "destructive" }),
  });

  const canSave = Boolean(draft.name.trim() && draft.pageId.trim() && (template || draft.id.trim()));

  return (
    <div
      className="ml-6 space-y-1 border-l border-border/40 pb-3 pl-3 pr-2 pt-2"
      data-testid={template ? `template-editor-${template.id}` : "template-editor-new"}
    >
      {!template && (
        <ProfileTreeRow label="Id" hasValue={Boolean(draft.id.trim())} showEmpty mobileLayout="inline" testId="row-template-id">
          <Input
            autoFocus
            value={draft.id}
            onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
            placeholder="spec"
            className="h-8"
            data-testid="input-template-id"
          />
        </ProfileTreeRow>
      )}
      <ProfileTreeRow label="Name" hasValue={Boolean(draft.name.trim())} showEmpty mobileLayout="inline" testId="row-template-name">
        <Input
          autoFocus={Boolean(template)}
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="Spec"
          className="h-8"
          data-testid="input-template-name"
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Page" hasValue={Boolean(draft.pageId)} showEmpty mobileLayout="inline" testId="row-template-page">
        <ReferencePicker
          types={["page"]}
          mode="single"
          variant="compact"
          dense
          placeholder="Shape page"
          value={pageValue}
          onChange={(next) => {
            const page = next[0];
            setDraft((current) => ({
              ...current,
              pageId: page?.id ?? "",
              pageLabel: page?.label ?? "",
            }));
          }}
          testId="picker-template-page"
        />
      </ProfileTreeRow>
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()} data-testid="button-save-template">
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

function TemplateRow({
  template,
  open,
  onToggle,
}: {
  template: DocumentTemplate;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="group" data-testid={`template-row-${template.id}`}>
      <div className={cn(HIERARCHY_SESSION_ROW_CLASS, "cursor-pointer")} onClick={onToggle}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" data-testid={`button-template-${template.id}`}>
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <FileStack className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm text-foreground">{template.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{template.id}</span>
          <span className="min-w-0 flex-1 truncate text-right text-sm">
            <span className="pointer-events-none">
              <InlineReferenceText text={`@page:${template.pageId}`} />
            </span>
          </span>
          {template.scope === "user" && (
            <span className="shrink-0 text-xs text-muted-foreground">account</span>
          )}
        </button>
      </div>
      {open && <TemplateEditor template={template} onClose={onToggle} />}
    </div>
  );
}

export default function TemplatesPage() {
  usePageHeader({ title: "Templates" });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const endpoint = search.trim()
    ? `/api/templates?query=${encodeURIComponent(search.trim())}`
    : "/api/templates";
  const { data, isLoading, error, refetch } = useQuery<TemplatesResponse>({ queryKey: [endpoint] });
  const templates = useMemo(() => data?.templates ?? [], [data?.templates]);
  const [sectionOpen, setSectionOpen] = useState(true);

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid="templates-page">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId="input-search-templates"
          clearTestId="button-clear-template-search"
          ariaLabel="Search templates"
        />
        {creating ? (
          <TemplateEditor onClose={() => setCreating(false)} />
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpenId(null);
              setCreating(true);
            }}
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            data-testid="button-new-template"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            New Template
          </button>
        )}

        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading templates…</div>
        ) : error ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            Templates unavailable.{" "}
            <button type="button" className="text-cta" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <Collapsible open={sectionOpen} onOpenChange={setSectionOpen}>
            <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover:bg-accent/70")}>
              <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", sectionOpen && "rotate-90")} />
              Templates · {templates.length}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {templates.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No templates.</div>
              ) : (
                templates.map((template) => (
                  <TemplateRow
                    key={`${template.scope}:${template.id}`}
                    template={template}
                    open={openId === template.id}
                    onToggle={() => {
                      setCreating(false);
                      setOpenId(openId === template.id ? null : template.id);
                    }}
                  />
                ))
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
