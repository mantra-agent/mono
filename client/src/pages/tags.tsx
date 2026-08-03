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
import type { Tag, TagIndex, TagUsageEntry, TagWithUsage } from "@shared/models/tags";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface TagDraft {
  label: string;
  description: string;
  aliasesText: string;
}

function emptyDraft(): TagDraft {
  return { label: "", description: "", aliasesText: "" };
}

function draftFromTag(tag: Tag): TagDraft {
  return {
    label: tag.label,
    description: tag.description ?? "",
    aliasesText: (tag.aliases ?? []).join(", "),
  };
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

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

function formatEntityType(entityType: string): string {
  return entityType.replace(/_/g, " ");
}

function TagEditor({
  tag,
  usages = [],
  nested = false,
  onClose,
}: {
  tag?: TagWithUsage;
  usages?: TagUsageEntry[];
  nested?: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<TagDraft>(() => (tag ? draftFromTag(tag) : emptyDraft()));
  const [deleteOpen, setDeleteOpen] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const label = draft.label.trim();
      const description = draft.description.trim();
      const aliases = parseAliases(draft.aliasesText);
      if (tag) {
        return (
          await apiRequest("PATCH", `/api/tags/${encodeURIComponent(tag.slug)}`, {
            label,
            description,
            aliases,
          })
        ).json() as Promise<Tag>;
      }
      return (
        await apiRequest("POST", "/api/tags", {
          label,
          description,
          aliases,
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
        title: tag ? "Could not update tag" : "Could not create tag",
        description: mutationErrorMessage(error, "The tag was not saved."),
        variant: "destructive",
      });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!tag) return;
      await apiRequest("DELETE", `/api/tags/${encodeURIComponent(tag.slug)}`);
    },
    onSuccess: async () => {
      await invalidateTags();
      setDeleteOpen(false);
      onClose();
    },
    onError: (error) => {
      toast({
        title: "Could not delete tag",
        description: mutationErrorMessage(error, "The tag was not deleted."),
        variant: "destructive",
      });
    },
  });

  const canSave = Boolean(draft.label.trim()) && !save.isPending;

  return (
    <div
      className={cn(
        "space-y-3 pb-3 pt-2",
        nested ? "ml-6 border-l border-border/40 pl-3 pr-2" : "px-2",
      )}
      data-testid={tag ? `tag-editor-${tag.slug}` : "tag-editor-new"}
    >
      <Input
        autoFocus={!tag}
        value={draft.label}
        onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
        placeholder="Tag label"
        data-testid="input-tag-label"
      />
      <Textarea
        value={draft.description}
        onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        placeholder="Description (optional)"
        className="min-h-20"
        data-testid="textarea-tag-description"
      />
      <Input
        value={draft.aliasesText}
        onChange={(event) => setDraft((current) => ({ ...current, aliasesText: event.target.value }))}
        placeholder="Aliases, comma-separated"
        data-testid="input-tag-aliases"
      />

      {tag && (
        <div className="space-y-1" data-testid={`tag-usages-${tag.slug}`}>
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Used on · {usages.length}
          </div>
          {usages.length === 0 ? (
            <div className="px-0 py-1 text-sm text-muted-foreground">No assignments yet.</div>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {usages.map((usage) => (
                <div
                  key={`${usage.entityType}:${usage.entityId}`}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground"
                  data-testid={`tag-usage-${usage.entityType}-${usage.entityId}`}
                >
                  <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground/80">
                    {formatEntityType(usage.entityType)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/90">
                    {usage.entityTitle || usage.entityId}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div>
          {tag && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
              data-testid={`button-delete-tag-${tag.slug}`}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => save.mutate()}
            data-testid="button-save-tag"
          >
            {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>

      {tag && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {tag.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                Removes the tag and its assignments. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={remove.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  remove.mutate();
                }}
              >
                {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
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
  return (
    <div data-testid={`tag-row-${tag.slug}`}>
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
      >
        <TagsIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{tag.label}</span>
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
                onToggle();
              }}
              data-testid={`menu-tag-edit-${tag.slug}`}
            >
              Edit
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
      {open && <TagEditor tag={tag} usages={tag.usages} nested onClose={onToggle} />}
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
      if (tag.slug.toLowerCase().includes(q)) return true;
      if ((tag.description ?? "").toLowerCase().includes(q)) return true;
      return (tag.aliases ?? []).some((alias) => alias.toLowerCase().includes(q));
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
        <TagEditor
          onClose={() => setCreating(false)}
        />
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
