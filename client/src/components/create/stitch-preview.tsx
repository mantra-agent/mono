import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Play, Pause, SkipForward } from "lucide-react";
import type { MediaItem } from "@shared/models/media";

interface StitchPreviewProps {
  clips: MediaItem[];
  onClipChange?: (index: number) => void;
}

export function StitchPreview({ clips, onClipChange }: StitchPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);

  const playClip = useCallback((index: number) => {
    if (index >= clips.length) {
      setIsPlaying(false);
      setCurrentIndex(0);
      onClipChange?.(0);
      return;
    }
    setCurrentIndex(index);
    onClipChange?.(index);
    const video = videoRef.current;
    if (video) {
      video.src = clips[index].objectPath;
      video.play().catch(() => {});
    }
  }, [clips, onClipChange]);

  const handleEnded = useCallback(() => {
    playClip(currentIndex + 1);
  }, [currentIndex, playClip]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || totalDuration === 0) return;
    const elapsed = clips.slice(0, currentIndex).reduce((sum, c) => sum + (c.duration || 0), 0) + video.currentTime;
    setProgress((elapsed / totalDuration) * 100);
  }, [clips, currentIndex, totalDuration]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      if (!video.src || video.ended) {
        playClip(0);
      }
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying, playClip]);

  const skipNext = useCallback(() => {
    playClip(currentIndex + 1);
  }, [currentIndex, playClip]);

  useEffect(() => {
    setCurrentIndex(0);
    setProgress(0);
    setIsPlaying(false);
  }, [clips.length]);

  if (clips.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="aspect-video bg-black rounded-lg overflow-hidden relative">
        <video
          ref={videoRef}
          className="w-full h-full"
          onEnded={handleEnded}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={togglePlay}>
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="outline" size="sm" onClick={skipNext} disabled={currentIndex >= clips.length - 1}>
          <SkipForward className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          Clip {currentIndex + 1} of {clips.length}
        </span>
      </div>
    </div>
  );
}
