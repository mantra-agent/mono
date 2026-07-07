import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SimpleAction, SimpleFeed, SimpleFeedItem } from "@shared/models/simple";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { SimpleCheckCircle } from "./home-check-circle";

interface SimpleCheckRowProps {
  item: SimpleFeedItem;
  sublabel?: string | null;
}

function completeAction(item: SimpleFeedItem): SimpleAction | null {
  return item.actions?.find(action => action.type === "complete") ?? null;
}

function sourceType(item: SimpleFeedItem): string | null {
  return item.sourceRefs?.[0]?.type ?? null;
}

function primaryReference(item: SimpleFeedItem) {
  return item.references?.[0] ?? (item.sourceRefs?.[0] ? sourceRefToReferenceRef(item.sourceRefs[0]) : null);
}

function markItemDone(feed: SimpleFeed | undefined, itemId: string): SimpleFeed | undefined {
  if (!feed) return feed;
  let completedItem: SimpleFeedItem | null = null;
  const sections = feed.sections
    .map(section => ({
      ...section,
      items: section.items.filter(item => {
        if (item.id !== itemId) return true;
        completedItem = { ...item, section: "done", status: "completed", completedAt: new Date().toISOString() };
        return false;
      }),
    }))
    .filter(section => section.items.length > 0);

  if (!completedItem) return feed;
  const doneSection = sections.find(section => section.section === "done");
  if (doneSection) doneSection.items = [completedItem, ...doneSection.items];
  else sections.push({ section: "done", items: [completedItem] });
  return { ...feed, sections };
}

export function SimpleCheckRow({ item, sublabel }: SimpleCheckRowProps) {
  const queryClient = useQueryClient();
  const action = completeAction(item);
  const reference = primaryReference(item);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error("No completion action available");
      await apiRequest("POST", `/api/home/items/${encodeURIComponent(item.id)}/complete`, {
        actionId: action.id,
        sourceType: action.sourceRef?.type ?? sourceType(item),
        payload: action.payload ?? {},
      });
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/home/feed"] });
      queryClient.setQueriesData<SimpleFeed>({ queryKey: ["/api/home/feed"] }, old => markItemDone(old, item.id));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/home/feed"] });
    },
  });

  const completed = item.status === "completed" || mutation.isSuccess;
  const disabled = !action || mutation.isPending || completed;

  return (
    <div className="group flex min-h-10 items-center gap-3 px-0 py-1.5">
      <SimpleCheckCircle
        checked={completed}
        pending={mutation.isPending}
        disabled={disabled}
        label={`Complete ${item.title}`}
        onClick={() => mutation.mutate()}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {reference ? (
            <ReferenceRenderer refValue={reference} surface="simple-row" className={completed ? "text-neutral hover:text-neutral" : undefined} />
          ) : (
            <span className={cn("truncate text-sm font-medium", completed && "text-neutral line-through decoration-neutral/60")}>{item.title}</span>
          )}
        </div>
        {sublabel ? <div className="mt-1 truncate text-xs text-muted-foreground">{sublabel}</div> : null}
      </div>
    </div>
  );
}
