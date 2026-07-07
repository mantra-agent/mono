import { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { MediaGrid } from "./media-grid";
import { ClipCard } from "./clip-card";
import { StitchPreview } from "./stitch-preview";
import { StitchControls } from "./stitch-controls";
import { Film } from "lucide-react";
import type { MediaItem } from "@shared/models/media";

export function StitchPanel() {
  const [sequence, setSequence] = useState<MediaItem[]>([]);
  const [activeClipIndex, setActiveClipIndex] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const addClip = useCallback((item: MediaItem) => {
    if (item.mediaType !== "video") return;
    setSequence((prev) => {
      // Don't add duplicates
      if (prev.some((c) => c.id === item.id)) return prev;
      return [...prev, item];
    });
  }, []);

  const removeClip = useCallback((id: string) => {
    setSequence((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setSequence((prev) => {
      const oldIndex = prev.findIndex((c) => c.id === active.id);
      const newIndex = prev.findIndex((c) => c.id === over.id);
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  const totalDuration = sequence.reduce((sum, c) => sum + (c.duration || 0), 0);

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="grid grid-cols-1 @lg:grid-cols-2 gap-4 h-full">
      {/* Left: video-only media grid */}
      <div className="flex flex-col min-h-0 overflow-y-auto scrollbar-thin border rounded-lg p-3">
        <h3 className="text-sm font-medium mb-3">Video Library</h3>
        <MediaGrid videoOnly onAddToStitch={addClip} />
      </div>

      {/* Right: sequence builder */}
      <div className="flex flex-col gap-4 min-h-0">
        {/* Preview */}
        {sequence.length > 0 && (
          <StitchPreview clips={sequence} onClipChange={setActiveClipIndex} />
        )}

        {/* Sequence list */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin border rounded-lg p-3">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">Sequence</h3>
            {sequence.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {sequence.length} clip{sequence.length !== 1 ? "s" : ""} · {formatDuration(totalDuration)} total
              </span>
            )}
          </div>

          {sequence.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Film className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Drag video clips here to build your sequence</p>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sequence.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-2">
                  {sequence.map((clip, i) => (
                    <ClipCard
                      key={clip.id}
                      item={clip}
                      isActive={i === activeClipIndex}
                      onRemove={() => removeClip(clip.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Render controls */}
        {sequence.length > 0 && (
          <StitchControls clipIds={sequence.map((c) => c.id)} />
        )}
      </div>
    </div>
  );
}
