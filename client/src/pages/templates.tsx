import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createReferenceRef } from "@shared/references";
import type { DocumentTemplate } from "@shared/models/document-templates";
import { ChevronRight, FileStack, Loader2, MoreHorizontal, Plus, X } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InlineLibraryPageEditor } from "@/components/library/inline-library-page";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferencePicker } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface TemplatesResponse {
  templates: DocumentTemplate[];
}

interface TemplateBindingsResponse {
  skills: Array<{ id: string; name: string }>;
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

function invalidateTemplates() {
  return queryClient.invalidateQueries({
    predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/templates"),
  });
}

function TemplatePagePicker({
  currentId,
  currentLabel,
  onAssign,
  onCancel,
}: {
  currentId?: string;
  currentLabel?: string;
  onAssign: (pageId: string) => void;
  onCancel?: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <ReferencePicker
        value={currentId ? [{ type: "page", id: currentId, label: currentLabel || currentId }] : []}
        onChange={(next) => {
          const selected = next[0];
          if (selected) onAssign(selected.id);
        }}
        types={["page"]}
        mode="single"
        variant="compact"
        placeholder="Choose page"
        showToken={false}
        className={HIERARCHY_PRIMARY_ACTION_CLASS}
        testId="picker-template-page"
      />
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground/70"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function TemplateCreateEditor({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [pageId, setPageId] = useState("");
  const [pageLabel, setPageLabel] = useState("");
  const save = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/templates", {
          id: id.trim(),
          name: name.trim(),
          pageId: pageId.trim(),
        })
      ).json() as Promise<DocumentTemplate>,
    onSuccess: () => {
      invalidateTemplates();
      onClose();
    },
    onError: (error) =>
      toast({ title: "Could not save template", description: mutationErrorMessage(error), variant: "destructive" }),
  });
  const canSave = Boolean(id.trim() && name.trim() && pageId.trim());

  return (
    <div className="ml-6 space-y-1 border-l border-border/40 pb-3 pl-3 pr-2 pt-2" data-testid="template-editor-new">
      <ProfileTreeRow label="Id" hasValue={Boolean(id.trim())} showEmpty mobileLayout="inline" testId="row-template-id">
        <Input
          autoFocus
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="spec"
          className="h-8"
          data-testid="input-template-id"
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Name" hasValue={Boolean(name.trim())} showEmpty mobileLayout="inline" testId="row-template-name">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Spec"
          className="h-8"
          data-testid="input-template-name"
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Page" hasValue={Boolean(pageId)} showEmpty mobileLayout="inline" testId="row-template-page">
        <TemplatePagePicker
          currentId={pageId || undefined}
          currentLabel={pageLabel || undefined}
          onAssign={(nextPageId) => {
            setPageId(nextPageId);
            setPageLabel(nextPageId);
          }}
        />
      </ProfileTreeRow>
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() => save.mutate()}
          data-testid="button-save-template"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

function TemplatePageSlot({ template }: { template: DocumentTemplate }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const assign = useMutation({
    mutationFn: async (pageId: string) => {
      const res = await apiRequest("PATCH", `/api/templates/${template.id}`, { pageId });
      return res.json() as Promise<DocumentTemplate>;
    },
    onSuccess: () => {
      invalidateTemplates();
      setEditing(false);
    },
    onError: (error) =>
      toast({ title: "Could not retarget page", description: mutationErrorMessage(error), variant: "destructive" }),
  });
  const pageRef = createReferenceRef({
    type: "page",
    id: template.pageId,
    metadata: { label: template.pageId, href: `/info#library?page=${encodeURIComponent(template.pageId)}` },
  });

  return (
    <ProfileTreeRow
      label="Page"
      hasValue
      showEmpty
      mobileLayout="inline"
      menuVisibility="hover"
      testId="row-template-page"
      expandedContent={
        editing ? undefined : (
          <InlineLibraryPageEditor
            page={{ id: template.pageId, title: template.pageId, slug: template.pageId }}
          />
        )
      }
      menuContent={
        <DropdownMenuItem
          disabled={assign.isPending}
          onSelect={() => setEditing(true)}
          data-testid={`menu-template-page-change-${template.id}`}
        >
          Change page
        </DropdownMenuItem>
      }
    >
      {editing ? (
        <TemplatePagePicker
          currentId={template.pageId}
          currentLabel={template.pageId}
          onAssign={(pageId) => assign.mutate(pageId)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <ReferenceRenderer refValue={pageRef} surface="simple-chip" />
      )}
    </ProfileTreeRow>
  );
}

function TemplateSkillBindings({ templateId, open }: { templateId: string; open: boolean }) {
  const { data, isLoading } = useQuery<TemplateBindingsResponse>({
    queryKey: [`/api/templates/${templateId}/bindings`],
    enabled: open,
  });
  const skills = data?.skills ?? [];

  return (
    <ProfileTreeRow
      label="Skills"
      hasValue={skills.length > 0}
      showEmpty
      mobileLayout="inline"
      testId={`row-template-skills-${templateId}`}
    >
      {isLoading ? (
        <span className="text-sm text-muted-foreground">Loading…</span>
      ) : skills.length === 0 ? (
        <span className="text-sm text-muted-foreground">None</span>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          {skills.map((skill) => (
            <InlineReferenceText key={skill.id} text={`@skill:${skill.id}`} />
          ))}
        </span>
      )}
    </ProfileTreeRow>
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
  const { toast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(template.name);
  const rename = useMutation({
    mutationFn: async (name: string) => {
      await apiRequest("PATCH", `/api/templates/${template.id}`, { name });
    },
    onSuccess: () => invalidateTemplates(),
    onError: (error) =>
      toast({ title: "Could not rename template", description: mutationErrorMessage(error), variant: "destructive" }),
    onSettled: () => setEditingName(false),
  });
  const commitName = () => {
    const next = nameDraft.trim();
    if (!next || next === template.name) {
      setNameDraft(template.name);
      setEditingName(false);
      return;
    }
    rename.mutate(next);
  };

  return (
    <div className="group" data-testid={`template-row-${template.id}`}>
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "pr-16",
          open ? "bg-accent text-foreground" : "hover:bg-accent/70 hover:text-foreground",
        )}
        onClick={onToggle}
      >
        <span className="flex shrink-0 items-center justify-center">
          <FileStack className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </span>
        {editingName ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitName();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setNameDraft(template.name);
                setEditingName(false);
              }
            }}
            onBlur={commitName}
            className="h-6 min-w-0 flex-1 border-0 bg-muted/40 px-1.5 text-sm shadow-none focus-visible:ring-1"
            data-testid={`input-template-row-name-${template.id}`}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              setNameDraft(template.name);
              setEditingName(true);
            }}
            data-testid={`text-template-name-${template.id}`}
          >
            {template.name}
          </button>
        )}
        <button
          type="button"
          className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          aria-label={open ? "Collapse details" : "Expand details"}
          data-testid={`button-template-twisty-${template.id}`}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md bg-accent/50 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                open && "bg-accent opacity-100",
              )}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(true);
              }}
              aria-label={`Actions for ${template.name}`}
              data-testid={`button-template-menu-${template.id}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem
              onSelect={() => {
                setMenuOpen(false);
                onToggle();
              }}
              data-testid={`menu-template-expand-${template.id}`}
            >
              {open ? "Collapse" : "Expand"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="ml-6 border-l border-border/40 py-1 pl-3 pr-2" data-testid={`template-editor-${template.id}`}>
          <TemplateSkillBindings templateId={template.id} open={open} />
          <TemplatePageSlot template={template} />
        </div>
      )}
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
          <TemplateCreateEditor onClose={() => setCreating(false)} />
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
        ) : templates.length === 0 ? (
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
      </div>
    </div>
  );
}
