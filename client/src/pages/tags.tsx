import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tag, Search, ArrowLeft, Merge, Trash2, Loader2, Link2, ExternalLink } from "lucide-react";
import type { Tag as TagModel, CoOccurrenceEdge, TagUsageEntry } from "@shared/schema";

interface TagsData {
  tags: TagModel[];
  coOccurrences: CoOccurrenceEdge[];
}

interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
  reason: string;
}

function TagLens({
  tag,
  onClose,
  allTags,
  coOccurrences,
}: {
  tag: TagModel;
  onClose: () => void;
  allTags: TagModel[];
  coOccurrences: CoOccurrenceEdge[];
}) {
  const { toast } = useToast();

  const { data: detail } = useQuery<TagModel & { usages: TagUsageEntry[] }>({
    queryKey: ["/api/tags", tag.slug],
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/tags/${tag.slug}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
      toast({ title: "Tag deleted" });
      onClose();
    },
  });

  const related = useMemo(() => {
    return coOccurrences
      .filter((e) => e.source === tag.slug || e.target === tag.slug)
      .map((e) => ({
        slug: e.source === tag.slug ? e.target : e.source,
        weight: e.weight,
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12);
  }, [coOccurrences, tag.slug]);

  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-lens">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Tag className="h-4 w-4 text-muted-foreground" />
        <span className="text-lg font-medium">{tag.label}</span>
        <Badge variant="outline" className="no-default-hover-elevate text-xs ml-auto">
          {tag.usageCount} uses
        </Badge>
      </div>

      {tag.description && (
        <p className="text-sm text-muted-foreground">{tag.description}</p>
      )}

      {tag.aliases.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">Aliases</span>
          <div className="flex flex-wrap gap-1">
            {tag.aliases.map((a) => (
              <Badge key={a} variant="outline" className="text-xs no-default-hover-elevate">{a}</Badge>
            ))}
          </div>
        </div>
      )}

      {related.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">Related Tags</span>
          <div className="flex flex-wrap gap-1">
            {related.map((r) => {
              const t = allTags.find((t) => t.slug === r.slug);
              return (
                <Badge key={r.slug} variant="outline" className="text-xs gap-1" data-testid={`related-${r.slug}`}>
                  <Link2 className="h-2.5 w-2.5" />
                  {t?.label ?? r.slug}
                  <span className="text-xs text-muted-foreground">{r.weight}</span>
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {detail?.usages && detail.usages.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">Used By</span>
          <div className="space-y-1">
            {detail.usages.map((u, i) => (
              <div key={`${u.entityType}-${u.entityId}-${i}`} className="flex items-center gap-2 text-sm">
                <Badge variant="outline" className="text-xs no-default-hover-elevate shrink-0">{u.entityType}</Badge>
                <span className="truncate">{u.entityTitle || u.entityId}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pt-2 border-t">
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setDeleteOpen(true)}
            data-testid="button-delete-tag"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            Delete tag
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete tag "{tag.label}"?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes the tag from the registry. Existing entities that reference it will keep their tag strings but lose the registry entry.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete-tag"
              >
                {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function MergeSuggestions({ duplicates, allTags }: { duplicates: DuplicateCandidate[]; allTags: TagModel[] }) {
  const { toast } = useToast();

  const mergeMutation = useMutation({
    mutationFn: async ({ sourceSlug, targetSlug }: { sourceSlug: string; targetSlug: string }) => {
      const res = await apiRequest("POST", "/api/tags/merge", { sourceSlug, targetSlug });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tags/duplicates"] });
      toast({ title: "Tags merged" });
    },
  });

  if (duplicates.length === 0) return null;

  return (
    <Card className="p-4 border-card-border bg-card shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Merge className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Merge Suggestions</span>
      </div>
      <div className="space-y-2">
        {duplicates.map((d) => {
          const tagA = allTags.find((t) => t.slug === d.a);
          const tagB = allTags.find((t) => t.slug === d.b);
          return (
            <div key={`${d.a}-${d.b}`} className="flex items-center gap-2 text-sm flex-wrap">
              <Badge variant="outline" className="text-xs">{tagA?.label ?? d.a}</Badge>
              <span className="text-muted-foreground text-xs">{d.reason}</span>
              <Badge variant="outline" className="text-xs">{tagB?.label ?? d.b}</Badge>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => mergeMutation.mutate({ sourceSlug: d.a, targetSlug: d.b })}
                disabled={mergeMutation.isPending}
                data-testid={`button-merge-${d.a}-${d.b}`}
              >
                <Merge className="h-3 w-3 mr-1" />
                Merge
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function TagsPage({ embedded }: { embedded?: boolean }) {
  const [search, setSearch] = useState("");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery<TagsData>({
    queryKey: ["/api/tags"],
  });

  const { data: dupsData } = useQuery<{ duplicates: DuplicateCandidate[] }>({
    queryKey: ["/api/tags/duplicates"],
  });

  const tags = data?.tags ?? [];
  const coOccurrences = data?.coOccurrences ?? [];
  const duplicates = dupsData?.duplicates ?? [];

  const filteredTags = useMemo(() => {
    if (!search.trim()) return tags;
    const q = search.toLowerCase();
    return tags.filter(
      (t) =>
        t.label.includes(q) ||
        t.slug.includes(q) ||
        t.aliases.some((a) => a.includes(q))
    );
  }, [tags, search]);

  const selectedTag = tags.find((t) => t.slug === selectedSlug) ?? null;

  if (isLoading) {
    return (
      <div className={cn("space-y-3", embedded ? "p-4 bg-background" : "p-4")}>
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 @sm:grid-cols-3 @md:grid-cols-4 gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      </div>
    );
  }

  if (selectedTag) {
    return (
      <div className={cn("p-4", embedded ? "max-w-none bg-background" : "max-w-2xl")}>
        <TagLens
          tag={selectedTag}
          onClose={() => setSelectedSlug(null)}
          allTags={tags}
          coOccurrences={coOccurrences}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", embedded && "bg-background text-foreground")}>
      <div className="p-4 space-y-4 overflow-y-auto flex-1">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags..."
              className="pl-8 text-sm"
              data-testid="input-tag-search"
            />
          </div>
          <span className="text-xs text-muted-foreground">{tags.length} tags</span>
        </div>

        <MergeSuggestions duplicates={duplicates} allTags={tags} />

        {filteredTags.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <Tag className="h-8 w-8 mb-3 opacity-50" />
            <p className="text-sm">No tags found</p>
            <p className="text-xs mt-1">Tags are created when you add them to goals, principles, and other items.</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {filteredTags.map((tag) => (
              <Badge
                key={tag.slug}
                variant="secondary"
                className="gap-1.5 cursor-pointer text-xs py-1 px-2.5 border border-card-border bg-card hover:bg-accent hover:text-accent-foreground transition-colors"
                onClick={() => setSelectedSlug(tag.slug)}
                data-testid={`tag-item-${tag.slug}`}
              >
                <Tag className="h-3 w-3" />
                {tag.label}
                <span className="text-xs text-muted-foreground">{tag.usageCount}</span>
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
