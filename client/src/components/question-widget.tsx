import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, MessageCircleQuestion, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import {
  normalizeQuestionPrompt,
  type QuestionPrincipleOption,
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

type PrincipleListItem = {
  id: string;
  title: string;
  layer1?: string | null;
  currentRevisionId?: string | null;
};

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

function PrincipleSearchInput({
  value,
  onChange,
  disabled,
  testId,
  clearTestId,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  testId: string;
  clearTestId: string;
}) {
  return (
    <div className="relative min-w-0">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="Search principles"
        placeholder="Search"
        className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        data-testid={testId}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          disabled={disabled}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
          data-testid={clearTestId}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
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
  const [selectedPrinciples, setSelectedPrinciples] = useState<string[]>(
    () =>
      response?.selectedPrincipleRevisionIds ??
      recommendation?.principleRevisionIds ??
      [],
  );
  const [principleCatalog, setPrincipleCatalog] = useState<QuestionPrincipleOption[]>(prompt.principles);
  const [principleQuery, setPrincipleQuery] = useState("");
  const [principlesLoading, setPrinciplesLoading] = useState(false);
  const [reasoning, setReasoning] = useState(
    () => prompt.allowResponseReasoning
      ? response?.reasoning ?? recommendation?.reasoning ?? ""
      : "",
  );
  // Principles stay collapsed unless the agent already checked some.
  const [showContext, setShowContext] = useState(
    () => Boolean(recommendation?.principleRevisionIds?.length),
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
    setSelectedPrinciples(response.selectedPrincipleRevisionIds ?? []);
    setReasoning(response.reasoning ?? "");
    if (response.decisionId) setLocalDecisionId(response.decisionId);
  }, [response]);

  useEffect(() => {
    let cancelled = false;
    const loadPrinciples = async () => {
      setPrinciplesLoading(true);
      try {
        const res = await fetch("/api/principles");
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const items: PrincipleListItem[] = Array.isArray(body)
          ? body
          : Array.isArray(body?.principles)
            ? body.principles
            : Array.isArray(body?.items)
              ? body.items
              : [];
        if (cancelled) return;
        const mapped: QuestionPrincipleOption[] = items
          .map((item) => {
            const revisionId = item.currentRevisionId;
            if (!revisionId || !item.id || !item.title) return null;
            return {
              principleId: item.id,
              revisionId,
              title: item.title,
              layer1: item.layer1 ?? "",
            } satisfies QuestionPrincipleOption;
          })
          .filter((item): item is QuestionPrincipleOption => Boolean(item));
        if (mapped.length === 0) return;
        setPrincipleCatalog((current) => {
          const byRevision = new Map(current.map((p) => [p.revisionId, p]));
          for (const principle of mapped) byRevision.set(principle.revisionId, principle);
          return Array.from(byRevision.values()).sort((a, b) => a.title.localeCompare(b.title));
        });
      } catch (loadError) {
        log.warn("QUESTION_WIDGET:PRINCIPLES_LOAD_FAILED", {
          toolCallId: prompt.toolCallId,
          error: loadError instanceof Error ? loadError.message : String(loadError),
        });
      } finally {
        if (!cancelled) setPrinciplesLoading(false);
      }
    };
    void loadPrinciples();
    return () => {
      cancelled = true;
    };
  }, [prompt.toolCallId]);

  const answeredLabels = useMemo(
    () => (response ? responseLabels(prompt, response) : []),
    [prompt, response],
  );

  const isSingle = prompt.selectionMode === "single";

  const filteredPrinciples = useMemo(() => {
    const q = principleQuery.trim().toLowerCase();
    if (!q) return principleCatalog;
    return principleCatalog.filter((principle) => {
      const haystack = `${principle.title} ${principle.layer1}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [principleCatalog, principleQuery]);

  const selectedPrincipleLabels = useMemo(() => {
    const ids = response?.selectedPrincipleRevisionIds ?? selectedPrinciples;
    if (!ids.length) return [];
    const byRevision = new Map(principleCatalog.map((p) => [p.revisionId, p]));
    for (const principle of prompt.principles) byRevision.set(principle.revisionId, principle);
    return ids
      .map((id) => byRevision.get(id)?.title)
      .filter((title): title is string => Boolean(title));
  }, [principleCatalog, prompt.principles, response?.selectedPrincipleRevisionIds, selectedPrinciples]);

  const selectOption = (optionId: string) => {
    setError(null);
    if (isSingle) {
      setSelected([optionId]);
      setOtherSelected(false);
      setOtherText("");
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
      if (next && isSingle) setSelected([]);
      return next;
    });
  };

  const togglePrinciple = (revisionId: string) => {
    setError(null);
    setSelectedPrinciples((current) =>
      current.includes(revisionId)
        ? current.filter((id) => id !== revisionId)
        : [...current, revisionId],
    );
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
      ...(prompt.allowResponseReasoning && trimmedReasoning ? { reasoning: trimmedReasoning } : {}),
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
          return (
            <ExpandableDetailRow
              key={option.id}
              checked={selected.includes(option.id)}
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
          {otherSelected && (
            <textarea
              autoFocus
              value={otherText}
              onChange={(event) => setOtherText(event.target.value)}
              disabled={controlsDisabled}
              rows={2}
              placeholder="Add your answer"
              className="ml-[26px] mt-1 w-[calc(100%-26px)] resize-none rounded-sm border border-border/30 bg-transparent p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border/60"
              data-testid={`question-other-text-${prompt.toolCallId}`}
            />
          )}
        </div>
      </div>
      {prompt.allowResponseReasoning ? (
        <div className="space-y-1.5 border-t border-border/40 px-3 py-2">
          <label
            htmlFor={`question-reasoning-${prompt.toolCallId}`}
            className="sr-only"
          >
            Reasoning (optional)
          </label>
          <textarea
            id={`question-reasoning-${prompt.toolCallId}`}
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
            disabled={controlsDisabled}
            rows={2}
            placeholder="Reasoning (optional)"
            className="w-full resize-none rounded-sm border border-border/30 bg-transparent p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border/60"
            data-testid={`question-reasoning-${prompt.toolCallId}`}
          />
        </div>
      ) : null}
      <Collapsible
        open={showContext}
        onOpenChange={setShowContext}
        className="border-t border-border/40"
      >
        <CollapsibleTrigger
          disabled={controlsDisabled}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          data-testid={`question-provenance-toggle-${prompt.toolCallId}`}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", showContext && "rotate-90")} />
          <span className="min-w-0 flex-1">Principles</span>
          {principlesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          {selectedPrinciples.length > 0 ? (
            <span className="text-[10px] font-normal text-muted-foreground/70">{selectedPrinciples.length}</span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-2 pb-2">
            <PrincipleSearchInput
              value={principleQuery}
              onChange={setPrincipleQuery}
              disabled={controlsDisabled}
              testId={`question-principle-search-${prompt.toolCallId}`}
              clearTestId={`question-principle-search-clear-${prompt.toolCallId}`}
            />
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {filteredPrinciples.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {principleCatalog.length === 0
                    ? "No principles available yet."
                    : "No principles match that search."}
                </p>
              ) : (
                filteredPrinciples.map((principle) => (
                  <ExpandableDetailRow
                    key={principle.revisionId}
                    checked={selectedPrinciples.includes(principle.revisionId)}
                    disabled={controlsDisabled}
                    label={principle.title}
                    detail={principle.layer1 || undefined}
                    testId={`question-principle-${prompt.toolCallId}-${principle.revisionId}`}
                    onSelect={() => togglePrinciple(principle.revisionId)}
                  />
                ))
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
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
