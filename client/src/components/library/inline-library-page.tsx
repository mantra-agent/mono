import { useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { createReferenceRef } from "@shared/references";
import { isValidTiptapDoc, markdownToTiptap } from "@shared/markdown-tiptap";
import { RichTextEditor } from "@/components/rich-text-editor";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { useEditableContent } from "@/hooks/use-editable-content";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface InlineLibraryPageRecord {
  id: string;
  title: string;
  slug: string;
  content: JSONContent | null;
  plainTextContent: string;
}

export interface InlineLibraryPageRef {
  id: string;
  title: string;
  slug: string;
}

function useInlineLibraryPage(page: InlineLibraryPageRef) {
  return useQuery<InlineLibraryPageRecord>({
    queryKey: ["/api/info/library", page.id],
    enabled: Boolean(page.id),
  });
}

export function InlineLibraryPageEditor({
  page,
  readOnly = false,
  className,
}: {
  page: InlineLibraryPageRef;
  readOnly?: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useInlineLibraryPage(page);
  const initialContent = useMemo<JSONContent | null>(() => {
    if (!data) return null;
    if (isValidTiptapDoc(data.content)) return data.content;
    return data.plainTextContent?.trim() ? markdownToTiptap(data.plainTextContent) as JSONContent : null;
  }, [data]);

  const saveMutation = useMutation<unknown, Error, { id: string; title: string; content: JSONContent | null; plainTextContent: string }>({
    mutationFn: async ({ id, title, content, plainTextContent }) => {
      await apiRequest("PATCH", `/api/info/library/${encodeURIComponent(id)}`, {
        title,
        content,
        plainTextContent,
      });
    },
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: ["/api/info/library", input.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/info/library"] });
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });

  const editable = useEditableContent({
    selectedId: data?.id ?? null,
    initialTitle: data?.title ?? page.title,
    initialContent,
    initialPlainText: data?.plainTextContent ?? "",
    saveMutation,
    debounceMs: 700,
  });

  if (isLoading) {
    return <div className="flex h-20 items-center justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  }
  if (isError || !data) {
    return <div className="px-2 py-1.5 text-sm text-destructive">Agenda page could not be loaded.</div>;
  }

  return (
    <div className={cn("relative min-h-28 overflow-hidden rounded-md border border-border/40 bg-card", className)}>
      {saveMutation.isPending && <Loader2 className="absolute right-2 top-2 z-10 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      <RichTextEditor
        key={data.id}
        value={editable.editContent}
        plainTextFallback={data.plainTextContent}
        onChange={editable.handleContentChange}
        placeholder="Add discussion points, decisions, and desired outcomes"
        readOnly={readOnly}
        className="min-h-28"
        data-testid={`editor-inline-library-page-${data.id}`}
      />
    </div>
  );
}

export function ExpandableLibraryPage({
  page,
  label,
  readOnly = false,
  defaultOpen = false,
  className,
}: {
  page: InlineLibraryPageRef;
  label?: string;
  readOnly?: boolean;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const href = `/info#library?page=${encodeURIComponent(page.slug)}`;
  const reference = createReferenceRef({
    type: "page",
    id: page.id,
    metadata: { label: page.title, href },
  });

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-h-8 items-center gap-2">
        {label && <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>}
        <ReferenceRenderer refValue={reference} surface="simple-row" className="min-w-0" />
        <button
          type="button"
          className="ml-auto rounded p-1 hover:bg-accent/60"
          onClick={() => setOpen(value => !value)}
          aria-label={open ? `Collapse ${page.title}` : `Expand ${page.title}`}
          data-testid={`button-toggle-inline-library-page-${page.id}`}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && <InlineLibraryPageEditor page={page} readOnly={readOnly} className="mt-2" />}
    </div>
  );
}
