import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import {
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Tags as TagsIcon,
  Trash2,
} from "lucide-react";
import type { EntityType, Tag, TagIndex, TagUsageEntry, TagWithUsage } from "@shared/models/tags";
import { createReferenceRef, type KnownReferenceType } from "@shared/references";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ReferenceChip } from "@/components/references/reference-chip";
import type { ClientResolvedReference } from "@/components/references/reference-registry";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

/** Entity types that have client reference routes and can render as chips. */
const CHIPABLE_ENTITY_TYPES = new Set<EntityType>([
  "goal",
  "task",
  "project",
  "principle",
  "person",
  "company",
  "page",
]);

function mutationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const jsonStart = error.message.indexOf("{");
  if (jsonStart === -1) return error.message || fallback;
  try {
    const parsed = JSON.parse(error.message.slice(jsonStart)) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : error.message || fallback;
  } catch {
    return error.message || fallback;
  }
}

function invalidateTags() {
  return queryClient.invalidateQueries({
    predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/tags"),
  });
}

function usageToReference(usage: TagUsageEntry): ClientResolvedReference | null {
  if (!CHIPABLE_ENTITY_TYPES.has(usage.entityType)) return null;
  const type = usage.entityType as KnownReferenceType;
  const ref = createReferenceRef({
    type,
    id: usage.entityId,
    metadata: { label: usage.entityTitle || usage.entityId },
  });
  return {
    ...ref,
    status: "resolved",
    label: usage.entityTitle || usage.entityId,
  };
}

function TagReferences({
  slug,
  usages,
}: {
  slug: string;
  usages: TagUsageEntry[];
}) {
  const chips = usages
    .map((usage) => {
      const reference = usageToReference(usage);
      return reference
        ? { key: `${usage.entityType}:${usage.entityId}`, reference }
        : null;
    })
    .filter((entry): entry is { key: string; reference: ClientResolvedReference } => Boolean(entry));

  return (
    <div
      className="ml-6 space-y-2 border-l border-border/40 py-2 pl-3 pr-2"
      data-testid={`tag-references-${slug}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        References · {usages.length}
      </div>
      {usages.length === 0 ? (
        <div className="px-0 py-1 text-sm text-muted-foreground">No references yet.</div>
      ) : chips.length === 0 ? (
        <div className="px-0 py-1 text-sm text-muted-foreground">
          {usages.length} assignment{usages.length === 1 ? "" : "s"} without navigable chips.
        </div>
      ) : (
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {chips.map(({ key, reference }) => (
            <ReferenceChip key={key} reference={reference} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewTagRow({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [label, setLabel] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = label.trim();
      return (
        await apiRequest("POST", "/api/tags", {
          label: trimmed,
          color: null,
        })
      ).json() as Promise<Tag>;
    },
    onSuccess: async () => {
      await invalidateTags();
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Could not create tag",
        description: mutationErrorMessage(error, "The tag was not saved."),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="px-2 py-1.5" data-testid="tag-editor-new" onClick={(event) => event.stopPropagation()}>
      <Input
        autoFocus
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Tag label"
        data-testid="input-tag-label"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (label.trim() && !create.isPending) create.mutate();
          }
        }}
        onBlur={() => {
          if (create.isPending) return;
          if (!label.trim()) {
            onClose();
            return;
          }
          create.mutate();
        }}
        disabled={create.isPending}
      />
    </div>
  );
}

function TagRow({
  tag,
  open,
  onToggle,
  onDelete,
}: {
  tag: TagWithUsage;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(tag.label);

  useEffect(() => {
    if (!editing) setDraftLabel(tag.label);
  }, [editing, tag.label]);

  const rename = useMutation({
    mutationFn: async (label: string) => {
      return (
        await apiRequest("PATCH", `/api/tags/${encodeURIComponent(tag.slug)}`, { label })
      ).json() as Promise<Tag>;
    },
    onSuccess: async () => {
      await invalidateTags();
      setEditing(false);
    },
    onError: (error) => {
      toast({
        title: "Could not rename tag",
        description: mutationErrorMessage(error, "The tag was not updated."),
        variant: "destructive",
      });
      setDraftLabel(tag.label);
      setEditing(false);
    },
  });

  const commitRename = () => {
    if (rename.isPending) return;
    const next = draftLabel.trim();
    if (!next || next === tag.label) {
      setDraftLabel(tag.label);
      setEditing(false);
      return;
    }
    rename.mutate(next);
  };

  return (
    <div data-testid={`tag-row-${tag.slug}`}>
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "group min-w-0 hover:bg-accent/70",
          open && "bg-accent text-foreground",
        )}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => {
          if (editing) return;
          onToggle();
        }}
        onKeyDown={(event) => {
          if (editing) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <TagsIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {editing ? (
          <Input
            autoFocus
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            className="h-7 min-w-0 flex-1 px-2 py-0 text-sm"
            data-testid={`input-tag-label-${tag.slug}`}
            disabled={rename.isPending}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                setDraftLabel(tag.label);
                setEditing(false);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commitRename();
              }
            }}
            onBlur={commitRename}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded-sm px-0.5 text-left hover:underline"
            data-testid={`button-edit-tag-label-${tag.slug}`}
            onClick={(event) => {
              event.stopPropagation();
              setDraftLabel(tag.label);
              setEditing(true);
            }}
          >
            {tag.label}
          </button>
        )}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {tag.usageCount}
        </span>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-label={open ? "Collapse tag" : "Expand tag"}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              data-testid={`button-tag-menu-${tag.slug}`}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Actions for ${tag.label}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem
              onClick={(event) => {
                event.stopPropagation();
                setDraftLabel(tag.label);
                setEditing(true);
              }}
              data-testid={`menu-tag-edit-${tag.slug}`}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              data-testid={`menu-tag-delete-${tag.slug}`}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && <TagReferences slug={tag.slug} usages={tag.usages} />}
    </div>
  );
}

function TagsTree({
  initialSlug = null,
}: {
  initialSlug?: string | null;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openSlug, setOpenSlug] = useState<string | null>(initialSlug);
  const [pendingDelete, setPendingDelete] = useState<TagWithUsage | null>(null);

  useEffect(() => {
    if (initialSlug) {
      setOpenSlug(initialSlug);
      setCreating(false);
    }
  }, [initialSlug]);

  const { data, isLoading, error, refetch } = useQuery<TagIndex>({
    queryKey: ["/api/tags"],
  });

  const tags = useMemo<TagWithUsage[]>(() => {
    if (!data?.tags) return [];
    const usages = data.usages ?? {};
    return Object.values(data.tags)
      .map((tag) => {
        const tagUsages = usages[tag.slug] ?? [];
        return {
          ...tag,
          usages: tagUsages,
          usageCount: tag.usageCount || tagUsages.length,
        };
      })
      .sort((a, b) => {
        if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
        return a.label.localeCompare(b.label);
      });
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((tag) => {
      if (tag.label.toLowerCase().includes(q)) return true;
      return tag.slug.toLowerCase().includes(q);
    });
  }, [search, tags]);

  const remove = useMutation({
    mutationFn: async (slug: string) => {
      await apiRequest("DELETE", `/api/tags/${encodeURIComponent(slug)}`);
    },
    onSuccess: async (_, slug) => {
      await invalidateTags();
      if (openSlug === slug) setOpenSlug(null);
      setPendingDelete(null);
    },
    onError: (error) => {
      toast({
        title: "Could not delete tag",
        description: mutationErrorMessage(error, "The tag was not deleted."),
        variant: "destructive",
      });
    },
  });

  return (
    <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="tags-tree">
      <HierarchySearchInput
        value={search}
        onChange={setSearch}
        inputTestId="input-search-tags"
        clearTestId="button-clear-tag-search"
        ariaLabel="Search tags"
      />

      {creating ? (
        <NewTagRow onClose={() => setCreating(false)} />
      ) : (
        <button
          type="button"
          onClick={() => {
            setOpenSlug(null);
            setCreating(true);
          }}
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          data-testid="button-new-tag"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          New Tag
        </button>
      )}

      {isLoading ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading tags…</div>
      ) : error ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          Tags unavailable.{" "}
          <button type="button" className="text-cta" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {tags.length === 0 ? "No tags yet." : "No tags match."}
        </div>
      ) : (
        <div className="space-y-0">
          {filtered.map((tag) => (
            <TagRow
              key={tag.slug}
              tag={tag}
              open={openSlug === tag.slug}
              onToggle={() => {
                setCreating(false);
                setOpenSlug((current) => (current === tag.slug ? null : tag.slug));
              }}
              onDelete={() => setPendingDelete(tag)}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the tag and its assignments. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending || !pendingDelete}
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) remove.mutate(pendingDelete.slug);
              }}
            >
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function TagsPage({ embedded = false }: { embedded?: boolean } = {}) {
  usePageHeader({ title: "Tags", skip: !!embedded });
  const [, params] = useRoute("/tags/:slug");
  const initialSlug = params?.slug ? decodeURIComponent(params.slug) : null;

  return (
    <div
      className={embedded ? "min-w-0" : "h-full w-full overflow-y-auto bg-background"}
      data-testid="tags-page"
    >
      <TagsTree initialSlug={initialSlug} />
    </div>
  );
}
