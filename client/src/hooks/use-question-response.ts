import { useCallback } from "react";
import { createLogger } from "@/lib/logger";
import { emitSessionChanged } from "@/hooks/use-data-sync";
import type { QuestionResponseMeta } from "@shared/question-prompt";
import type { useToast } from "@/hooks/use-toast";

const log = createLogger("QuestionResponse");

export function useQuestionResponse({
  sessionId,
  toast,
}: {
  sessionId: string | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return useCallback(async (questionResponse: QuestionResponseMeta): Promise<boolean> => {
    if (!sessionId) return false;

    const clientTurnId = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
      emitSessionChanged(sessionId, "question-answered");
      return true;
    } catch (error) {
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
  }, [sessionId, toast]);
}
