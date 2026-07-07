import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { GripVertical, X, Film, Play } from "lucide-react";
import type { MediaItem } from "@shared/models/media";

interface ClipCardProps {
  item: MediaItem;
  isActive?: boolean;
  onRemove: () => void;
}

export function ClipCard({ item, isActive, onRemove }: ClipCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  function formatDuration(seconds: number | null): string {
    if (!seconds) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          className={`group/clip flex items-center gap-2 rounded-lg border p-1.5 bg-card transition-colors ${
            isActive ? "ring-2 ring-primary border-primary" : ""
          }`}
        >
          <button
            className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>

          <div className="relative aspect-video h-14 rounded bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
            {item.thumbPath ? (
              <img src={item.thumbPath} alt="" className="h-full w-full object-cover" />
            ) : (
              <Film className="h-4 w-4 text-muted-foreground" />
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-full bg-black/40 p-1">
                <Play className="h-3 w-3 text-white fill-white" />
              </div>
            </div>
            {item.duration && (
              <span className="absolute bottom-0.5 right-0.5 text-xs bg-black/60 text-white px-1 rounded">
                {formatDuration(item.duration)}
              </span>
            )}
          </div>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/clip:opacity-100 transition-opacity"
            onClick={onRemove}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">{formatDuration(item.duration)}</p>
      </TooltipContent>
    </Tooltip>
  );
}
