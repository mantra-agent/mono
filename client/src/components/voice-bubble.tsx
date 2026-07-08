import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, X, Bot, ExternalLink, AlertCircle, CheckCircle2 } from "lucide-react";
import { useState } from "react";

export function VoiceBubble() {
  const voice = useVoiceSessionOptional();
  const { widgetOpen, setWidgetOpen } = useFocusSession();
  const [location] = useLocation();
  const [expanded, setExpanded] = useState(false);

  if (!voice) return null;

  const isActive = voice.status === "active" || voice.status === "connecting" || voice.status === "ending" || voice.status === "reconnecting";

  // Hide bubble when voice page (focus widget) is already open
  if (!isActive || widgetOpen) return null;

  const isConnecting = voice.status === "connecting";
  const isReconnecting = voice.status === "reconnecting";
  const isEnding = voice.status === "ending";
  const isSpeaking = voice.agentMode === "speaking";
  const isUserSpeaking = voice.userSpeaking;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2" data-testid="voice-bubble">
      {expanded && (
        <div className="w-72 max-h-64 bg-card border rounded-md shadow-lg overflow-hidden flex flex-col" data-testid="voice-bubble-panel">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
            <span className="text-xs font-medium">
              {isReconnecting ? "Reconnecting..." : isConnecting ? "Connecting..." : isEnding ? "Ending..." : isSpeaking ? "Agent is speaking" : isUserSpeaking ? "Hearing you..." : "Listening"}
            </span>
            <div className="flex items-center gap-0.5">
              <Button size="icon" variant="ghost" onClick={voice.toggleMute} data-testid="button-bubble-mute">
                {voice.isMuted ? <MicOff className="h-3 w-3 text-destructive" /> : <Mic className="h-3 w-3" />}
              </Button>
              <Button size="icon" variant="ghost" onClick={voice.endSession} disabled={isConnecting || isEnding} data-testid="button-bubble-end">
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2 space-y-1.5">
            {voice.transcript.slice(-6).map((entry, i) => (
              <div key={i} className="flex gap-1.5 items-start">
                <div className={`flex h-4 w-4 items-center justify-center rounded-full shrink-0 mt-0.5 ${entry.source === "system" && entry.isError ? "bg-destructive/10" : entry.source === "system" ? "bg-success/10" : entry.source === "ai" ? "bg-primary/10" : "bg-muted"}`}>
                  {entry.source === "system" ? (entry.isError ? <AlertCircle className="h-2.5 w-2.5 text-destructive" /> : <CheckCircle2 className="h-2.5 w-2.5 text-success-foreground" />) : entry.source === "ai" ? <Bot className="h-3 w-3 text-primary" /> : <Mic className="h-2.5 w-2.5 text-muted-foreground" />}
                </div>
                <p className={`text-xs leading-snug line-clamp-2 ${entry.source === "system" && entry.isError ? "text-destructive" : entry.source === "system" ? "text-success-foreground" : ""}`}>{entry.message}</p>
              </div>
            ))}
            {voice.transcript.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">Waiting for session...</p>
            )}
          </div>
          <div className="border-t px-1 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground gap-1"
              onClick={() => { setWidgetOpen(true); setExpanded(false); }}
              data-testid="button-bubble-open-full"
            >
              <ExternalLink className="h-3 w-3" />
              Open full view
            </Button>
          </div>
        </div>
      )}

      <Button
        size="icon"
        variant="default"
        onClick={() => setExpanded(prev => !prev)}
        className={`rounded-full shadow-lg ${
          isConnecting || isReconnecting ? "animate-pulse" :
          isUserSpeaking ? "ring-2 ring-error/50 ring-offset-2 ring-offset-background animate-pulse" :
          isSpeaking ? "ring-2 ring-primary/40 ring-offset-2 ring-offset-background" :
          ""
        }`}
        data-testid="button-voice-bubble"
      >
        <Mic className={`h-5 w-5 ${isUserSpeaking ? "text-error" : ""}`} />
      </Button>
    </div>
  );
}
