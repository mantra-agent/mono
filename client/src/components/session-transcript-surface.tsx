import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageList } from "@/components/message-list";
import { MeetingHeaderBar } from "@/components/meeting-header-bar";
import { PlanStickyBar } from "@/components/plan-sticky-bar";
import { WorkflowStickyBar } from "@/components/workflow-sticky-bar";
import type { MeetingSessionMeta } from "@shared/models/chat";
import type { ChatMessage as Message } from "@/components/chat-shared";
import type { PendingChatTurn } from "@/hooks/use-chat-send";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";
import type { StreamingContent } from "@shared/streaming-types";
import type { VoiceTranscriptEntry } from "@/hooks/use-voice-session";

type ActivePlan = React.ComponentProps<typeof PlanStickyBar>["plan"];
type ActiveWorkflow = React.ComponentProps<typeof WorkflowStickyBar>["workflow"];

export interface SessionTranscriptSurfaceProps {
  activeSession: string;
  sessionKey?: string | null;
  messages: Message[];
  streaming: StreamingContent;
  isSessionStreaming: boolean;
  runActive?: boolean;
  msgsLoading: boolean;
  voiceActive: boolean;
  showVoiceTools: boolean;
  voiceStepsInsertIndex: number;
  voiceStatus: string;
  voiceTranscript: VoiceTranscriptEntry[];
  voiceThinking?: boolean;
  sessionTitleById?: Record<string, string>;
  pendingTurn?: PendingChatTurn | null;
  optimisticUserTurn?: PendingChatTurn | null;
  liveStreamRenderId?: string | null;
  sessionStreams?: SessionStreamMap;
  wsConnected: boolean;
  sessionStatus?: string | null;
  plan?: ActivePlan | null;
  workflow?: ActiveWorkflow | null;
  meeting?: MeetingSessionMeta | null;
  sessionTitle?: string;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onUserScrollIntent: React.UIEventHandler<HTMLDivElement>;
  className?: string;
  listClassName?: string;
  compactReferences?: boolean;
}

const TERMINAL_PLAN_STATUSES = new Set(["completed", "completed_with_failures", "failed", "aborted"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed", "canceled"]);

export function SessionTranscriptSurface({
  activeSession,
  sessionKey,
  messages,
  streaming,
  isSessionStreaming,
  runActive,
  msgsLoading,
  voiceActive,
  showVoiceTools,
  voiceStepsInsertIndex,
  voiceStatus,
  voiceTranscript,
  voiceThinking,
  sessionTitleById,
  pendingTurn,
  optimisticUserTurn,
  liveStreamRenderId,
  sessionStreams,
  wsConnected,
  sessionStatus,
  plan,
  workflow,
  meeting,
  sessionTitle,
  scrollContainerRef,
  onScroll,
  onUserScrollIntent,
  className,
  listClassName,
  compactReferences = false,
}: SessionTranscriptSurfaceProps) {
  const showPlan = !!plan && !TERMINAL_PLAN_STATUSES.has(plan.status);
  const showWorkflow = !!workflow && !TERMINAL_WORKFLOW_STATUSES.has(workflow.run.status);
  const workflowOwnsPlan = !!showPlan && !!showWorkflow && workflow.linked?.planId === plan.id;

  return (
    <div className={cn("flex flex-col flex-1 min-h-0 overflow-hidden", className)} data-testid="session-transcript-surface">
      {meeting && <MeetingHeaderBar meeting={meeting} sessionTitle={sessionTitle} />}
      {!wsConnected && sessionStatus === "streaming" && !voiceActive && (
        <div
          className="flex items-center gap-2 px-4 py-2 bg-warning/5 dark:bg-warning/5 border-b border-warning/20 text-warning-foreground text-xs"
          data-testid="banner-ws-unhealthy"
        >
          <WifiOff className="h-3 w-3 flex-shrink-0" />
          <span>Real-time connection interrupted — updates may be delayed</span>
        </div>
      )}
      {showWorkflow && workflowOwnsPlan && <WorkflowStickyBar workflow={workflow} />}
      {showPlan && <PlanStickyBar plan={plan} />}
      {showWorkflow && !workflowOwnsPlan && <WorkflowStickyBar workflow={workflow} />}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] scrollbar-thin"
        onWheel={onUserScrollIntent}
        onTouchMove={onUserScrollIntent}
        onScroll={onScroll}
      >
        <div className={cn("space-y-6 p-4 pb-4 overflow-hidden", listClassName)}>
          <MessageList
            messages={messages}
            streaming={streaming}
            isSessionStreaming={isSessionStreaming}
            runActive={runActive}
            msgsLoading={msgsLoading}
            activeSession={activeSession}
            sessionKey={sessionKey}
            voiceActive={voiceActive}
            showVoiceTools={showVoiceTools}
            voiceStepsInsertIndex={voiceStepsInsertIndex}
            voiceStatus={voiceStatus}
            voiceTranscript={voiceTranscript}
            voiceThinking={voiceThinking}
            sessionTitleById={sessionTitleById}
            pendingTurn={pendingTurn}
            optimisticUserTurn={optimisticUserTurn}
            liveStreamRenderId={liveStreamRenderId}
            sessionStreams={sessionStreams}
            compactReferences={compactReferences}
          />
        </div>
      </div>
    </div>
  );
}
