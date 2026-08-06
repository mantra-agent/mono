import { useCallback } from "react";
import { createLogger } from "@/lib/logger";
import { emitSessionChanged } from "@/hooks/use-data-sync";
import type { QuestionResponseMeta } from "@shared/question-prompt";
import type { useToast } from "@/hooks/use-toast";

const log = createLogger("QuestionResponse");

export type QuestionSubmitResult = {
  ok: boolean;
  decisionId?: string;
};

export function useQuestionResponse({
  sessionId,
  toast,
}: {
  sessionId: string | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return useCallback(async (questionResponse: QuestionResponseMeta): Promise<QuestionSubmitResult> => {
    if (!sessionId) return { ok: false };

    const clientTurnId = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const questionToolCallId = questionResponse.questionToolCallId;
    log.info("QUESTION_TRACE:SUBMIT_START", {
      sessionId,
      questionToolCallId,
      clientTurnId,
      submittedAt: Date.now(),
    });

    try {
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTurnId, questionResponse }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "Failed to submit answer");
      }
      const decisionId =
        typeof body?.decisionId === "string" && body.decisionId
          ? body.decisionId
          : undefined;
      log.info("QUESTION_TRACE:SUBMIT_ACCEPTED", {
        sessionId,
        questionToolCallId,
        clientTurnId,
        decisionId: decisionId ?? null,
        acceptedAt: Date.now(),
      });
      emitSessionChanged(sessionId, "question-answered");
      log.info("QUESTION_TRACE:SESSION_INVALIDATED", {
        sessionId,
        questionToolCallId,
        clientTurnId,
        invalidatedAt: Date.now(),
      });
      return {
        ok: true,
        ...(decisionId ? { decisionId } : {}),
      };
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
      return { ok: false };
    }
  }, [sessionId, toast]);
}

export function useQuestionCancel({
  sessionId,
  toast,
}: {
  sessionId: string | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/question/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Failed to dismiss question");
      }
      emitSessionChanged(sessionId, "question-cancelled");
      return true;
    } catch (error) {
      log.error("QUESTION_RESPONSE:CANCEL_FAILED", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      toast({
        title: "Failed to dismiss question",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
      return false;
    }
  }, [sessionId, toast]);
}
