import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Download, Trash2 } from "lucide-react";
import type { MediaItem } from "@shared/models/media";

interface MediaPreviewProps {
  item: MediaItem;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export function MediaPreview({ item, onClose, onDelete }: MediaPreviewProps) {
  const isVideo = item.mediaType === "video";
  const isAudio = item.mediaType === "audio";

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="truncate">{item.name}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-center min-h-[200px] max-h-[60vh]">
          {isVideo ? (
            <video
              src={item.objectPath}
              controls
              autoPlay
              className="max-w-full max-h-[60vh] rounded"
            />
          ) : isAudio ? (
            <audio src={item.objectPath} controls autoPlay className="w-full" />
          ) : (
            <img
              src={item.objectPath}
              alt={item.name}
              className="max-w-full max-h-[60vh] object-contain rounded"
            />
          )}
        </div>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            asChild
          >
            <a href={item.objectPath} download={item.name} target="_blank" rel="noopener noreferrer">
              <Download className="h-4 w-4 mr-1" /> Download
            </a>
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onDelete(item.id)}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
