import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getInstanceName } from "@/lib/instance-config";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Mic,
  MicOff,
  Bot,
  Loader2,
  ArrowLeft,
  ChevronRight,
  Clock,
  Wrench,
  FileText,
  Timer,
  Zap,
  Brain,
  MessageSquare,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { resolvePersonaIcon } from "@/lib/persona-icons";
import { useTimezone, formatTime, formatDate } from "@/hooks/use-timezone";
import type { VoiceSessionContextValue, VoiceTranscriptEntry } from "@/hooks/use-voice-session";

interface VoiceSessionSummary {
  id: string;
  templateName: string;
  date: string;
  createdAt: string;
  summary: string | null;
  metadata: {
    durationMs?: number;
    connectLatencyMs?: number;
    firstDeltaMs?: number;
    model?: string;
    profile?: string;
    voiceId?: string;
    endedBy?: string;
  };
  transcriptLength: number;
  toolCallCount: number;
}

interface ToolCallRecord {
  name: string;
  parameters: Record<string, unknown>;
  result: string;
  timestamp: string;
  durationMs?: number;
}

interface TranscriptEntry {
  source: "user" | "ai" | "system" | "tool";
  message: string;
  timestamp: string;
  toolCall?: ToolCallRecord;
  persona?: { id: number; name: string; icon: string };
}

interface VoiceSessionDetail {
  id: string;
  templateName: string;
  date: string;
  createdAt: string;
  transcript: TranscriptEntry[];
  toolCalls: ToolCallRecord[];
  metadata: VoiceSessionSummary["metadata"];
  systemPrompt: string;
  firstMessage: string;
  toolDefinitions: Array<{ name: string; description: string; parameters: any }>;
  structuredResults?: Record<string, unknown>;
  summary?: string;
}

function formatDuration(ms?: number): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatLatency(ms?: number): string {
  if (!ms && ms !== 0) return "--";
  return `${ms}ms`;
}

function getSessionLabel(templateName: string): string {
  if (templateName === "daily" || templateName === "checkin") return "Daily Check-in";
  if (templateName === "sod") return "Check-in";
  if (templateName === "eod") return "Reflection";
  return templateName;
}

export function VoiceTranscriptBubble({ entry, index }: { entry: VoiceTranscriptEntry; index: number }) {
  const isUser = entry.source === "user";
  const isSystem = entry.source === "system";
  const PersonaIcon = resolvePersonaIcon(entry.persona?.icon);

  if (isSystem) {
    return (
      <div className="flex gap-3 items-start animate-in fade-in slide-in-from-bottom-1 duration-200" data-testid={`voice-transcript-${index}`}>
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5 ${entry.isError ? "bg-destructive/10" : "bg-success/10"}`}>
          {entry.isError ? <AlertCircle className="h-4 w-4 text-destructive" /> : <CheckCircle2 className="h-4 w-4 text-success-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`rounded-lg px-3 py-2 ${entry.isError ? "bg-destructive/5 border border-destructive/20" : "bg-success/5 border border-success/20"}`}>
            <p className={`text-sm ${entry.isError ? "text-destructive" : "text-success-foreground"}`}>{entry.message}</p>
          </div>
        </div>
      </div>
    );
  }

  const formattedTime = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  if (isUser) {
    return (
      <div className="flex justify-end animate-in fade-in slide-in-from-bottom-1 duration-200" data-testid={`voice-transcript-${index}`}>
        <div className="max-w-[75%]">
          <div className="bg-muted text-foreground rounded-2xl rounded-br-sm px-4 py-2.5">
            <p className="text-sm whitespace-pre-wrap">{entry.message}</p>
          </div>
          <div className="mt-1 flex items-center gap-1 justify-end">
            <Mic className="h-2.5 w-2.5 text-muted-foreground/50" />
            <span className="text-xs text-muted-foreground/50">Voice</span>
            {formattedTime && (
              <>
                <span className="text-xs text-muted-foreground/50">·</span>
                <span className="text-xs text-muted-foreground/50" data-testid={`voice-timestamp-user-${index}`}>{formattedTime}</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start animate-in fade-in slide-in-from-bottom-1 duration-200" data-testid={`voice-transcript-${index}`}>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
        <PersonaIcon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words overflow-hidden [&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0">
          <p>{entry.message}</p>
        </div>
        <div className="mt-1 flex items-center gap-1">
          <Mic className="h-2.5 w-2.5 text-muted-foreground/50" />
          <span className="text-xs text-muted-foreground/50">Voice</span>
          {formattedTime && (
            <>
              <span className="text-xs text-muted-foreground/50">·</span>
              <span className="text-xs text-muted-foreground/50" data-testid={`voice-timestamp-ai-${index}`}>{formattedTime}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function VoiceControlBar({ voiceSession, onEnd, transportHealthy = true }: { voiceSession: VoiceSessionContextValue; onEnd: () => void; transportHealthy?: boolean }) {
  const isConnecting = voiceSession.status === "connecting";
  const isReconnecting = voiceSession.status === "reconnecting";
  const isEnding = voiceSession.status === "ending";
  const isActive = voiceSession.status === "active";
  const isListening = voiceSession.agentMode === "listening";
  const isUserSpeaking = voiceSession.userSpeaking;
  // Unified status (task-923 step 3). The bubble cannot say "Speaking..."
  // while the transport is interrupted — that's the disagreement bug
  // shown in the screenshot. When transportHealthy is false during an
  // otherwise-active session, surface a single honest state.
  const showAsReconnecting = isReconnecting || (isActive && !transportHealthy);

  return (
    <div className="border-t p-4" data-testid="voice-control-bar">
      <div className="">
        <div className={`flex items-center gap-3 bg-muted/50 rounded-lg px-4 py-3`}>
          {isConnecting ? (
            <div className="flex items-center justify-between w-full">
              <span className="text-xs text-muted-foreground">Connecting voice session...</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={onEnd}
                disabled={isEnding}
                data-testid="button-voice-end"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <div className={`flex h-10 w-10 items-center justify-center rounded-full shrink-0 ${
                isActive
                  ? (isListening
                    ? (isUserSpeaking ? "bg-error/20 animate-pulse" : "bg-primary/15")
                    : "bg-success/15")
                  : "bg-muted"
              }`}>
                {showAsReconnecting ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : isActive ? (
                  isListening ? <Mic className={`h-5 w-5 ${isUserSpeaking ? "text-error" : "text-primary"}`} /> : <Bot className="h-5 w-5 text-success" />
                ) : (
                  <MicOff className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">
                  {showAsReconnecting ? "Reconnecting..." : isEnding ? "Ending..." : isListening ? (isUserSpeaking ? "Hearing you..." : "Listening...") : "Speaking..."}
                </span>
                {isActive && (
                  <span className="text-xs text-muted-foreground block">
                    {voiceSession.transcript.length} messages
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {isActive && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={voiceSession.toggleMute}
                    data-testid="button-voice-mute"
                  >
                    {voiceSession.isMuted ? <MicOff className="h-4 w-4 text-destructive" /> : <Mic className="h-4 w-4" />}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={onEnd}
                  disabled={isEnding}
                  data-testid="button-voice-end"
                >
                  End
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function VoiceSessionRow({ session, onClick }: { session: VoiceSessionSummary; onClick: () => void }) {
  const { timezone } = useTimezone();
  const templateLabel = getSessionLabel(session.templateName);
  const time = formatTime(session.createdAt, timezone, { hour: "2-digit", minute: "2-digit" });
  const date = formatDate(session.createdAt, timezone, { month: "short", day: "numeric" });

  return (
    <Card
      className="p-4 hover-elevate cursor-pointer"
      onClick={onClick}
      data-testid={`voice-session-${session.id}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
          <Mic className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{templateLabel}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-xs text-muted-foreground">{date} {time}</span>
            {session.metadata.durationMs && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Timer className="h-3 w-3" />
                {formatDuration(session.metadata.durationMs)}
              </span>
            )}
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              {session.transcriptLength}
            </span>
            {session.toolCallCount > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Wrench className="h-3 w-3" />
                {session.toolCallCount}
              </span>
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
      {session.summary && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{session.summary}</p>
      )}
    </Card>
  );
}

function TimingBadge({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <div>
        <span className="text-xs text-muted-foreground block leading-none">{label}</span>
        <span className="text-xs font-medium leading-tight">{value}</span>
      </div>
    </div>
  );
}

function TranscriptEntryRow({ entry, toolCalls, index, personaIcon }: { entry: TranscriptEntry; toolCalls: ToolCallRecord[]; index: number; personaIcon?: string }) {
  const { timezone } = useTimezone();
  const isAi = entry.source === "ai";
  const isUser = entry.source === "user";
  const isTool = entry.source === "tool";
  const PersonaIcon = resolvePersonaIcon(personaIcon);
  const time = entry.timestamp ? formatTime(entry.timestamp, timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

  const matchingToolCall = isTool && entry.toolCall ? entry.toolCall :
    isTool ? toolCalls.find(tc => {
      const entryTime = new Date(entry.timestamp).getTime();
      const tcTime = new Date(tc.timestamp).getTime();
      return Math.abs(entryTime - tcTime) < 2000;
    }) : undefined;

  if (isTool) {
    return (
      <div className="flex gap-2" data-testid={`transcript-entry-${index}`}>
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-warning/10 shrink-0 mt-0.5">
          <Wrench className="h-3 w-3 text-warning-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-mono font-medium px-2 py-0.5">
              {matchingToolCall?.name || "tool"}
            </span>
            {matchingToolCall?.durationMs !== undefined && (
              <span className="text-xs text-muted-foreground">{matchingToolCall.durationMs}ms</span>
            )}
            {time && <span className="text-xs text-muted-foreground ml-auto">{time}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{entry.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2" data-testid={`transcript-entry-${index}`}>
      <div className={`flex h-6 w-6 items-center justify-center rounded-full shrink-0 mt-0.5 ${
        isAi ? "bg-primary/10" : "bg-muted"
      }`}>
        {isAi ? (
          <PersonaIcon className="h-3 w-3 text-primary" />
        ) : (
          <Mic className="h-3 w-3 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {isAi ? getInstanceName() : "You"}
          </span>
          {time && <span className="text-xs text-muted-foreground">{time}</span>}
        </div>
        <p className="text-sm mt-0.5">{entry.message}</p>
      </div>
    </div>
  );
}

export function VoiceSessionDetailView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { timezone } = useTimezone();
  const { data: session, isLoading } = useQuery<VoiceSessionDetail>({
    queryKey: ["/api/sessions/voice/sessions", sessionId],
  });
  if (isLoading || !session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const templateLabel = getSessionLabel(session.templateName);
  const time = formatTime(session.createdAt, timezone, { hour: "2-digit", minute: "2-digit" });
  const date = formatDate(session.createdAt, timezone, { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" onClick={onBack} data-testid="button-back-voice-session">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium">{templateLabel}</h2>
            <p className="text-xs text-muted-foreground">{date} at {time}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {session.metadata.durationMs !== undefined && (
            <TimingBadge label="Duration" value={formatDuration(session.metadata.durationMs)} icon={<Timer className="h-3 w-3" />} />
          )}
          {session.metadata.connectLatencyMs !== undefined && (
            <TimingBadge label="Connect" value={formatLatency(session.metadata.connectLatencyMs)} icon={<Zap className="h-3 w-3" />} />
          )}
          {session.metadata.firstDeltaMs !== undefined && (
            <TimingBadge label="First Response" value={formatLatency(session.metadata.firstDeltaMs)} icon={<Clock className="h-3 w-3" />} />
          )}
          {session.metadata.profile && (
            <TimingBadge label="Profile" value={session.metadata.profile} icon={<Brain className="h-3 w-3" />} />
          )}
          {session.metadata.model && (
            <TimingBadge label="Model" value={session.metadata.model} icon={<Bot className="h-3 w-3" />} />
          )}
          <TimingBadge label="Messages" value={String(session.transcript.length)} icon={<MessageSquare className="h-3 w-3" />} />
          <TimingBadge label="Tool Calls" value={String(session.toolCalls.length)} icon={<Wrench className="h-3 w-3" />} />
        </div>

        {session.summary && (
          <Card className="p-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-1">Summary</h3>
            <p className="text-sm">{session.summary}</p>
          </Card>
        )}

        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group" data-testid="button-toggle-system-prompt">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            System Prompt
            <Badge variant="secondary" className="text-xs font-mono px-1 py-0 ml-1">{session.systemPrompt.length} chars</Badge>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Card className="p-3 mt-2">
              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto scrollbar-thin leading-relaxed">
                {session.systemPrompt}
              </pre>
            </Card>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group" data-testid="button-toggle-tool-defs">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            Tool Definitions
            <Badge variant="secondary" className="text-xs font-mono px-1 py-0 ml-1">{session.toolDefinitions.length}</Badge>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-1.5">
              {session.toolDefinitions.map((tool, i) => (
                <Card key={i} className="p-3">
                  <span className="text-xs font-mono font-medium">{tool.name}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{tool.description}</p>
                </Card>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {session.structuredResults && Object.keys(session.structuredResults).length > 0 && (
          <Card className="p-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Structured Results</h3>
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap">
              {JSON.stringify(session.structuredResults, null, 2)}
            </pre>
          </Card>
        )}

        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
            <FileText className="h-3 w-3" />
            Transcript
          </h3>
          <div className="space-y-2">
            {session.transcript.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No transcript recorded</p>
            ) : (
              session.transcript.map((entry, i) => (
                <TranscriptEntryRow key={i} entry={entry} toolCalls={session.toolCalls} index={i} personaIcon={entry.persona?.icon} />
              ))
            )}
          </div>
        </div>

        {session.toolCalls.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
              <Wrench className="h-3 w-3" />
              Tool Calls Timeline
            </h3>
            <div className="space-y-1.5">
              {session.toolCalls.map((tc, i) => (
                <Card key={i} className="p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="bg-cat-system/15 text-cat-system-foreground border border-cat-system/30 rounded-sm text-xs font-mono font-medium px-2 py-0.5">{tc.name}</span>
                    {tc.durationMs !== undefined && (
                      <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                        <Timer className="h-2.5 w-2.5" />
                        {tc.durationMs}ms
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatTime(tc.timestamp, timezone, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                  <div className="mt-1.5 text-xs font-mono text-muted-foreground">
                    <span className="text-xs uppercase tracking-wider">Params:</span>{" "}
                    {JSON.stringify(tc.parameters)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    <span className="text-xs uppercase tracking-wider">Result:</span>{" "}
                    {tc.result}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
