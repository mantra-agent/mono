import { useCallback } from "react";
import { createLogger } from "@/lib/logger";
import { emitSessionChanged } from "@/hooks/use-data-sync";
import type { PendingChatTurn } from "@/hooks/use-chat-send";
import type { QuestionResponseMeta } from "@shared/question-prompt";
import type { useToast } from "@/hooks/use-toast";

const log = createLogger("QuestionResponse");

export function useQuestionResponse({
  sessionId,
  enabled,
  busy,
  pendingTurn,
  setPendingTurn,
  toast,
}: {
  sessionId: string | null;
  enabled: boolean;
  busy: boolean;
  pendingTurn: PendingChatTurn | null;
  setPendingTurn?: (turn: PendingChatTurn | null) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return useCallback(async (questionResponse: QuestionResponseMeta): Promise<boolean> => {
    if (!sessionId || !enabled || busy || pendingTurn) return false;

    const clientTurnId = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const submittedAt = new Date().toISOString();
    const optimisticContent = `Question response\nQuestion tool call: ${questionResponse.questionToolCallId}\nAnswer submitted`;
    setPendingTurn?.({
      clientTurnId,
      sessionId,
      submittedAt,
      status: "posting",
      content: optimisticContent,
      hidden: true,
    });

    try {
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTurnId, questionResponse }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Failed to submit answer");
      }
      setPendingTurn?.({
        clientTurnId,
        sessionId,
        submittedAt,
        status: "streaming",
        content: optimisticContent,
        hidden: true,
      });
      emitSessionChanged(sessionId, "question-answered");
      return true;
    } catch (error) {
      setPendingTurn?.(null);
      log.error("QUESTION_RESPONSE:SUBMIT_FAILED", {
        sessionId,
        questionToolCallId: questionResponse.questionToolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
      toast({
        title: "Failed to submit answer",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return false;
    }
  }, [sessionId, enabled, busy, pendingTurn, setPendingTurn, toast]);
}
