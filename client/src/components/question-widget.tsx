import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { SIMPLE_TEXT_FRAME_CLASS } from "@/components/home/simple-text-frame";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import {
  normalizeQuestionPrompt,
  type QuestionPrompt,
  type QuestionResponseMeta,
} from "@shared/question-prompt";
import type { QuestionSubmitResult } from "@/hooks/use-question-response";

const log = createLogger("QuestionWidget");

export interface QuestionWidgetPrompt extends QuestionPrompt {
  toolCallId: string;
}

export interface QuestionRenderProvenance {
  messageListInstanceId: string;
  historical: boolean;
  carrierMessageId: string;
  source: "persisted" | "streaming";
  segmentIndex: number;
  stepIndex: number;
  occurrence: number;
}

const ANSWER_NOTE_TEXTAREA_CLASS =
  "min-h-0 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-xs leading-relaxed md:text-xs text-white shadow-none focus-visible:ring-0 focus-visible:ring-offset-0";

export function questionPromptFromToolCall(input: {
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  status?: string;
}): QuestionWidgetPrompt | null {
  if (input.toolName !== "question" || !input.toolCallId || input.status === "error") return null;
  const normalized = normalizeQuestionPrompt(input.arguments);
  if (!normalized.ok) return null;
  return { toolCallId: input.toolCallId, ...normalized.value };
}

function responseLabels(prompt: QuestionWidgetPrompt, response: QuestionResponseMeta): string[] {
  const optionById = new Map(prompt.options.map((option) => [option.id, option.label]));
  const labels = response.selectedOptionIds
    .map((id) => optionById.get(id))
    .filter((label): label is string => Boolean(label));
  if (response.otherText) labels.push(response.otherText);
  return labels;
}

function ExpandableDetailRow({
  checked,
  disabled,
  label,
  detail,
  testId,
  onSelect,
  badge,
  emphasized,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  detail?: string;
  testId: string;
  onSelect: () => void;
  badge?: string;
  emphasized?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailText = detail?.trim() || "";
  const hasDetail = detailText.length > 0;

  return (
    <div
      className={cn(
        "rounded-sm transition-colors",
        checked || emphasized ? "bg-accent/60" : "hover:bg-accent/40",
        emphasized && "ring-1 ring-primary/30",
        disabled && "opacity-60",
      )}
    >
      <div className="flex w-full items-start gap-1">
        {hasDetail ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse details for ${label}` : `Expand details for ${label}`}
            disabled={disabled}
            onClick={() => setExpanded((value) => !value)}
            className="mt-1.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
            data-testid={`${testId}-expand`}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : (
          <span className="mt-1.5 w-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          disabled={disabled}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2.5 px-1 py-1.5 pr-2 text-left",
            disabled && "cursor-not-allowed",
          )}
          data-testid={testId}
        >
          <SimpleCheckCircle checked={checked} interactive={false} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="block min-w-0 flex-1 text-sm text-foreground">{label}</span>
              {badge ? (
                <Badge
                  variant="secondary"
                  className="shrink-0 text-[10px] font-medium tabular-nums"
                  data-testid={`${testId}-confidence`}
                >
                  {badge}
                </Badge>
              ) : null}
            </span>
          </span>
        </button>
      </div>
      {hasDetail && expanded ? (
        <p className="pb-2 pl-9 pr-2 text-xs text-muted-foreground" data-testid={`${testId}-detail`}>
          {detailText}
        </p>
      ) : null}
    </div>
  );
}

function AnswerNoteField({
  value,
  onChange,
  disabled,
  placeholder,
  testId,
  id,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  testId: string;
  id?: string;
  label: string;
}) {
  return (
    <div className={cn(SIMPLE_TEXT_FRAME_CLASS, "ml-[26px] mt-1 w-[calc(100%-26px)] flex flex-col")}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        rows={2}
        placeholder={placeholder}
        className={ANSWER_NOTE_TEXTAREA_CLASS}
        data-testid={testId}
      />
    </div>
  );
}

function isSubmitOk(result: QuestionSubmitResult | boolean): result is QuestionSubmitResult {
  return typeof result === "object" && result !== null && "ok" in result;
}

export function QuestionWidget({
  prompt,
  response,
  onSubmit,
  onCancel,
  renderProvenance,
}: {
  prompt: QuestionWidgetPrompt;
  response?: QuestionResponseMeta;
  onSubmit: (response: QuestionResponseMeta) => Promise<QuestionSubmitResult | boolean>;
  onCancel?: () => Promise<boolean>;
  renderProvenance?: QuestionRenderProvenance;
}) {
  const recommendation = prompt.recommendation;
  const [selected, setSelected] = useState<string[]>(
    () => response?.selectedOptionIds ?? recommendation?.optionIds ?? [],
  );
  const [otherSelected, setOtherSelected] = useState(Boolean(response?.otherText));
  const [otherText, setOtherText] = useState(response?.otherText ?? "");
  const selectedPrinciples =
    response?.selectedPrincipleRevisionIds ??
    recommendation?.principleRevisionIds ??
    [];
  const [reasoning, setReasoning] = useState(
    () => response?.reasoning ?? recommendation?.reasoning ?? "",
  );
  const [showAnsweredDetails, setShowAnsweredDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recommendedOptionIds = useMemo(
    () => new Set(recommendation?.optionIds ?? []),
    [recommendation?.optionIds],
  );
  const recommendedConfidence = recommendation?.confidence;
  const [localDecisionId, setLocalDecisionId] = useState<string | undefined>(response?.decisionId);
  const isAnswered = Boolean(response) || prompt.status === "answered";
  const isSubmitting = submitting || cancelling;

  const widgetInstanceIdRef = useRef(`question-widget-${Math.random().toString(36).slice(2, 10)}`);
  const latestWidgetStateRef = useRef({
    status: prompt.status,
    isAnswered,
    decisionId: localDecisionId ?? response?.decisionId ?? null,
  });
  latestWidgetStateRef.current = {
    status: prompt.status,
    isAnswered,
    decisionId: localDecisionId ?? response?.decisionId ?? null,
  };

  useEffect(() => {
    log.info("QUESTION_TRACE:WIDGET_MOUNT", {
      widgetInstanceId: widgetInstanceIdRef.current,
      questionToolCallId: prompt.toolCallId,
      renderProvenance: renderProvenance ?? null,
      mountedAt: Date.now(),
    });
    return () => {
      log.info("QUESTION_TRACE:WIDGET_UNMOUNT", {
        widgetInstanceId: widgetInstanceIdRef.current,
        questionToolCallId: prompt.toolCallId,
        renderProvenance: renderProvenance ?? null,
        ...latestWidgetStateRef.current,
        unmountedAt: Date.now(),
      });
    };
  }, [prompt.toolCallId]);

  useEffect(() => {
    log.info("QUESTION_TRACE:WIDGET_STATE", {
      widgetInstanceId: widgetInstanceIdRef.current,
      questionToolCallId: prompt.toolCallId,
      status: prompt.status,
      isAnswered,
      isSubmitting,
      hasResponse: Boolean(response),
      decisionId: localDecisionId ?? response?.decisionId ?? null,
      changedAt: Date.now(),
    });
  }, [
    prompt.toolCallId,
    prompt.status,
    isAnswered,
    isSubmitting,
    response,
    localDecisionId,
  ]);

  const cancel = async () => {
    if (!onCancel) return;
    setCancelling(true);
    setError(null);
    // Optimistically hide; the server marker keeps it dismissed across reloads.
    setDismissed(true);
    try {
      const ok = await onCancel();
      if (!ok) {
        setDismissed(false);
        setError("Could not dismiss.");
      }
    } catch (cancelError) {
      setDismissed(false);
      log.error("QUESTION_WIDGET:CANCEL_FAILED", {
        toolCallId: prompt.toolCallId,
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
      setError(cancelError instanceof Error ? cancelError.message : "Could not dismiss.");
    } finally {
      setCancelling(false);
    }
  };

  useEffect(() => {
    if (!response) return;
    setSelected(response.selectedOptionIds);
    setOtherSelected(Boolean(response.otherText));
    setOtherText(response.otherText ?? "");
    setReasoning(response.reasoning ?? "");
    if (response.decisionId) setLocalDecisionId(response.decisionId);
  }, [response]);

  const answeredLabels = useMemo(
    () => (response ? responseLabels(prompt, response) : []),
    [prompt, response],
  );

  const isSingle = prompt.selectionMode === "single";

  const selectedPrincipleLabels = useMemo(() => {
    const ids = response?.selectedPrincipleRevisionIds ?? selectedPrinciples;
    if (!ids.length) return [];
    const byRevision = new Map(prompt.principles.map((p) => [p.revisionId, p]));
    return ids
      .map((id) => byRevision.get(id)?.title)
      .filter((title): title is string => Boolean(title));
  }, [prompt.principles, response?.selectedPrincipleRevisionIds, selectedPrinciples]);

  const selectOption = (optionId: string) => {
    setError(null);
    if (isSingle) {
      setSelected([optionId]);
      if (otherSelected) {
        const carried = otherText.trim();
        if (carried && !reasoning.trim()) setReasoning(carried);
        setOtherSelected(false);
        setOtherText("");
      }
      return;
    }
    setSelected((current) =>
      current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId],
    );
  };

  const toggleOther = () => {
    setError(null);
    setOtherSelected((current) => {
      const next = !current;
      if (!next) setOtherText("");
      if (next && isSingle) {
        const carried = reasoning.trim();
        if (carried && !otherText.trim()) setOtherText(carried);
        setSelected([]);
      }
      return next;
    });
  };

  const decisionId = response?.decisionId ?? localDecisionId;
  const whyAsking = prompt.reasoning?.trim() || "";

  const submit = async () => {
    const normalizedOther = otherSelected ? otherText.trim() : "";
    if (selected.length === 0 && !normalizedOther) {
      setError("Choose an answer.");
      return;
    }
    if (otherSelected && !normalizedOther) {
      setError("Add your answer.");
      return;
    }

    setSubmitting(true);
    setError(null);
    const trimmedReasoning = reasoning.trim();
    const nextResponse: QuestionResponseMeta = {
      questionToolCallId: prompt.toolCallId,
      selectedOptionIds: selected,
      ...(normalizedOther ? { otherText: normalizedOther } : {}),
      ...(selectedPrinciples.length > 0 ? { selectedPrincipleRevisionIds: selectedPrinciples } : {}),
      ...(trimmedReasoning ? { reasoning: trimmedReasoning } : {}),
    };
    try {
      const submitted = await onSubmit(nextResponse);
      const ok = isSubmitOk(submitted) ? submitted.ok : Boolean(submitted);
      if (!ok) {
        setError("Answer could not be submitted.");
        return;
      }
      if (isSubmitOk(submitted) && submitted.decisionId) {
        setLocalDecisionId(submitted.decisionId);
      }
    } catch (submitError) {
      log.error("QUESTION_WIDGET:SUBMIT_FAILED", {
        toolCallId: prompt.toolCallId,
        error: submitError instanceof Error ? submitError.message : String(submitError),
      });
      setError(submitError instanceof Error ? submitError.message : "Answer could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  if (response || localDecisionId) {
    const answer = (response ? answeredLabels : responseLabels(prompt, {
      questionToolCallId: prompt.toolCallId,
      selectedOptionIds: selected,
      ...(otherText.trim() ? { otherText: otherText.trim() } : {}),
    })).join(", ");
    const answerReasoning = response?.reasoning || reasoning.trim();
    const hasAnsweredDetails = Boolean(
      whyAsking || selectedPrincipleLabels.length > 0 || answerReasoning || decisionId,
    );

    return (
      <Collapsible
        open={showAnsweredDetails}
        onOpenChange={setShowAnsweredDetails}
        className="-ml-10 my-1 rounded-md border border-success/40 bg-success/5"
        data-testid={`question-widget-${prompt.toolCallId}`}
      >
        <div className="flex items-start gap-2.5 px-3 py-2">
          <SimpleCheckCircle checked interactive={false} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm text-muted-foreground">{prompt.question}</p>
            <p className="text-base font-semibold text-foreground">{answer}</p>
          </div>
          {hasAnsweredDetails ? (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={showAnsweredDetails ? "Collapse answer details" : "Expand answer details"}
                className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                data-testid={`question-answered-expand-${prompt.toolCallId}`}
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 transition-transform", showAnsweredDetails && "rotate-90")}
                />
              </button>
            </CollapsibleTrigger>
          ) : null}
        </div>
        {hasAnsweredDetails ? (
          <CollapsibleContent>
            <div className="space-y-1 border-t border-border/40 px-3 py-2 pl-12 text-sm font-normal italic text-muted-foreground">
              {whyAsking ? (
                <p data-testid={`question-why-${prompt.toolCallId}`}>Why I'm asking: {whyAsking}</p>
              ) : null}
              {selectedPrincipleLabels.length > 0 ? (
                <p>Principles: {selectedPrincipleLabels.join(", ")}</p>
              ) : null}
              {answerReasoning ? <p>Reasoning: {answerReasoning}</p> : null}
              {decisionId ? (
                <div className="not-italic" data-testid={`question-decision-${prompt.toolCallId}`}>
                  <InlineReferenceText text={`Recorded as @decision:${decisionId}`} />
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    );
  }

  if (dismissed) return null;

  const controlsDisabled = submitting || cancelling;
  return (
    <div
      className="-ml-10 border rounded-md border-border/60 bg-muted/20 my-1"
      data-testid={`question-widget-${prompt.toolCallId}`}
    >
      <div className="flex items-start gap-2 px-3 py-2 border-b border-border/40">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-active" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium text-foreground">{prompt.question}</p>
          {whyAsking ? (
            <p className="text-xs text-muted-foreground" data-testid={`question-why-${prompt.toolCallId}`}>
              Why I'm asking: {whyAsking}
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-0.5 px-2 py-2">
        {prompt.options.map((option) => {
          const isRecommended = recommendedOptionIds.has(option.id);
          const optionSelected = selected.includes(option.id);
          return (
            <div key={option.id}>
              <ExpandableDetailRow
                checked={optionSelected}
                disabled={controlsDisabled}
                label={option.label}
                detail={option.description}
                testId={`question-option-${prompt.toolCallId}-${option.id}`}
                onSelect={() => selectOption(option.id)}
                emphasized={isRecommended}
                badge={
                  isRecommended && typeof recommendedConfidence === "number"
                    ? `${recommendedConfidence}% confidence`
                    : undefined
                }
              />
              {optionSelected ? (
                <AnswerNoteField
                  id={`question-reasoning-${prompt.toolCallId}-${option.id}`}
                  value={reasoning}
                  onChange={setReasoning}
                  disabled={controlsDisabled}
                  placeholder="Reasoning (optional)"
                  label="Reasoning (optional)"
                  testId={`question-reasoning-${prompt.toolCallId}-${option.id}`}
                />
              ) : null}
            </div>
          );
        })}
        <div>
          <ExpandableDetailRow
            checked={otherSelected}
            disabled={controlsDisabled}
            label="Other"
            testId={`question-option-${prompt.toolCallId}-other`}
            onSelect={toggleOther}
          />
          {/* Other is the same selected-answer note: free-text hatch after selection. */}
          {otherSelected ? (
            <AnswerNoteField
              value={otherText}
              onChange={setOtherText}
              disabled={controlsDisabled}
              placeholder="Add your answer"
              label="Other answer"
              testId={`question-other-text-${prompt.toolCallId}`}
            />
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2">
        {error ? <p className="text-xs text-error">{error}</p> : <span />}
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={controlsDisabled}
              onClick={cancel}
              data-testid={`button-cancel-question-${prompt.toolCallId}`}
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Cancel"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="bg-cta text-cta-foreground hover:bg-cta/90"
            disabled={controlsDisabled}
            onClick={submit}
            data-testid={`button-answer-question-${prompt.toolCallId}`}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Answer"}
          </Button>
        </div>
      </div>
    </div>
  );
}
