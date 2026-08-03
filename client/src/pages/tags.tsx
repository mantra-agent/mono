import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, Search, Tags as TagsIcon } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import type { TagIndex, TagSearchResult, TagWithUsage } from "@shared/schema";
import { createReferenceRef, isKnownReferenceType } from "@shared/references";
import { ReferenceChip } from "@/components/references/reference-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";

function invalidateTagQueries() {
  queryClient.invalidateQueries({
    predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/tags"),
  });
}

function TagDetail({ slug, embedded = false, onBack }: { slug: string; embedded?: boolean; onBack: () => void }) {
  const [, setLocation] = useLocation();
  const { data: detail, isLoading, isError } = useQuery<TagWithUsage>({
    queryKey: [`/api/tags/${encodeURIComponent(slug)}`],
  });

  useEffect(() => {
    if (!embedded && detail && detail.slug !== slug) {
      setLocation(`/tags/${encodeURIComponent(detail.slug)}`, { replace: true });
    }
  }, [detail, embedded, setLocation, slug]);

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading tag…</div>;
  }

  if (isError || !detail) {
    return (
      <div className="py-16 text-center">
        <p className="font-medium">Tag not found</p>
        <p className="mt-1 text-sm text-muted-foreground">The tag may have been merged or removed.</p>
        <Button variant="outline" className="mt-4" onClick={onBack}>Back to Tags</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 gap-2">
        <ArrowLeft className="h-4 w-4" />
        All Tags
      </Button>

      <div className="flex items-start gap-4">
        <span className="mt-1 h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: detail.color }} />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{detail.label}</h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">@tag:{detail.slug}</p>
          {detail.description && <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{detail.description}</p>}
        </div>
      </div>

      {detail.aliases.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Also known as</p>
          <div className="flex flex-wrap gap-2">
            {detail.aliases.map((alias) => <Badge key={alias} variant="secondary">{alias}</Badge>)}
          </div>
        </div>
      )}

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-medium">Tagged items</h2>
            <p className="text-sm text-muted-foreground">
              {detail.usages.length} {detail.usages.length === 1 ? "item uses" : "items use"} this tag
            </p>
          </div>
        </div>
        {detail.usages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing uses this tag yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {detail.usages.map((usage) => {
              if (!isKnownReferenceType(usage.entityType)) {
                return <Badge key={`${usage.entityType}:${usage.entityId}`} variant="outline">{usage.entityTitle}</Badge>;
              }
              return (
                <ReferenceChip
                  key={`${usage.entityType}:${usage.entityId}`}
                  refData={createReferenceRef(usage.entityType, usage.entityId, { label: usage.entityTitle })}
                />
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function TagIndexSurface({ embedded = false }: { embedded?: boolean }) {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [newTagLabel, setNewTagLabel] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const normalizedSearch = searchQuery.trim();
  const searchUrl = `/api/tags/search?q=${encodeURIComponent(normalizedSearch)}&limit=50`;

  const { data: index, isLoading } = useQuery<TagIndex>({ queryKey: ["/api/tags"] });
  const { data: searchResults = [] } = useQuery<TagSearchResult[]>({
    queryKey: [searchUrl],
    enabled: normalizedSearch.length > 0,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: async (label: string) => {
      const response = await apiRequest("POST", "/api/tags", { label });
      return response.json() as Promise<{ slug: string }>;
    },
    onSuccess: (tag) => {
      invalidateTagQueries();
      setNewTagLabel("");
      setShowCreate(false);
      if (!embedded) setLocation(`/tags/${encodeURIComponent(tag.slug)}`);
    },
  });

  const indexTags = useMemo<TagSearchResult[]>(() => {
    if (!index) return [];
    return Object.values(index.tags).map((tag) => ({
      ...tag,
      usageCount: index.usages[tag.slug]?.length ?? 0,
    }));
  }, [index]);

  const tags = normalizedSearch ? searchResults : indexTags;
  const totalAssignments = index
    ? Object.values(index.usages).reduce((total, usages) => total + usages.length, 0)
    : 0;

  const openTag = (slug: string) => setLocation(`/tags/${encodeURIComponent(slug)}`);

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading tags…</div>;
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Tags</h1>
            <p className="mt-1 text-sm text-muted-foreground">Find, reuse, and consolidate the language connecting your work.</p>
          </div>
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New Tag
          </Button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search labels, slugs, or aliases…"
          className="pl-9"
          data-testid="input-tag-search"
        />
      </div>

      {showCreate && (
        <Card className="flex items-center gap-2 p-4">
          <Input
            autoFocus
            value={newTagLabel}
            onChange={(event) => setNewTagLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newTagLabel.trim()) createMutation.mutate(newTagLabel.trim());
              if (event.key === "Escape") setShowCreate(false);
            }}
            placeholder="Tag name"
            data-testid="input-new-tag"
          />
          <Button
            disabled={!newTagLabel.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate(newTagLabel.trim())}
          >
            Create
          </Button>
          <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
        </Card>
      )}

      <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
        <span>{indexTags.length} tags</span>
        <span>·</span>
        <span>{totalAssignments} assignments</span>
        {normalizedSearch && <><span>·</span><span>{tags.length} matches</span></>}
      </div>

      {tags.length === 0 ? (
        <Card className="py-16 text-center">
          <TagsIcon className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 font-medium">{normalizedSearch ? "No matching tags" : "No tags yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {normalizedSearch ? "Try a label, slug, or alias." : "Create one to start connecting your work."}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tags.map((tag) => (
            <Card
              key={tag.slug}
              className="cursor-pointer p-4 transition-colors hover:bg-muted/40"
              onClick={() => openTag(tag.slug)}
              data-testid={`tag-card-${tag.slug}`}
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{tag.label}</p>
                    <Badge variant="secondary">{tag.usageCount}</Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">@tag:{tag.slug}</p>
                  {tag.description && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{tag.description}</p>}
                  {tag.aliases.length > 0 && (
                    <p className="mt-2 truncate text-xs text-muted-foreground">Aliases: {tag.aliases.join(", ")}</p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}


    </div>
  );
}

export default function TagsPage({ embedded = false }: { embedded?: boolean }) {
  const [, params] = useRoute("/tags/:slug");
  const [, setLocation] = useLocation();
  const slug = params?.slug ? decodeURIComponent(params.slug) : null;

  return (
    <div className={embedded ? "" : "mx-auto w-full max-w-5xl px-6 py-8"} data-testid="tags-page">
      {slug ? (
        <TagDetail slug={slug} embedded={embedded} onBack={() => setLocation("/tags")} />
      ) : (
        <TagIndexSurface embedded={embedded} />
      )}
    </div>
  );
}
