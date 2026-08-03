import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
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

function OptionRow({
  checked,
  disabled,
  label,
  description,
  testId,
  onSelect,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  testId: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors",
        checked ? "bg-accent/60" : "hover:bg-accent/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
      data-testid={testId}
    >
      <SimpleCheckCircle checked={checked} interactive={false} className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">{description}</span>
        ) : null}
      </span>
    </button>
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
}: {
  prompt: QuestionWidgetPrompt;
  response?: QuestionResponseMeta;
  onSubmit: (response: QuestionResponseMeta) => Promise<QuestionSubmitResult | boolean>;
  onCancel?: () => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>(response?.selectedOptionIds ?? []);
  const [otherSelected, setOtherSelected] = useState(Boolean(response?.otherText));
  const [otherText, setOtherText] = useState(response?.otherText ?? "");
  const [selectedPrinciples, setSelectedPrinciples] = useState<string[]>(
    response?.selectedPrincipleRevisionIds ?? [],
  );
  const [principleCatalog, setPrincipleCatalog] = useState<QuestionPrincipleOption[]>(prompt.principles);
  const [principleQuery, setPrincipleQuery] = useState("");
  const [principlesLoading, setPrinciplesLoading] = useState(false);
  const [reasoning, setReasoning] = useState(response?.reasoning ?? "");
  const [showProvenance, setShowProvenance] = useState(
    Boolean(response?.selectedPrincipleRevisionIds?.length || response?.reasoning || prompt.reasoning),
  );
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localDecisionId, setLocalDecisionId] = useState<string | undefined>(response?.decisionId);

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
    return (
      <div
        className="-ml-10 border rounded-md border-success/40 bg-success/5 my-1"
        data-testid={`question-widget-${prompt.toolCallId}`}
      >
        <div className="flex items-start gap-2.5 px-3 py-2">
          <SimpleCheckCircle checked interactive={false} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm text-foreground">{prompt.question}</p>
            {whyAsking ? (
              <p className="text-xs text-muted-foreground" data-testid={`question-why-${prompt.toolCallId}`}>
                Why I'm asking: {whyAsking}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {(response ? answeredLabels : responseLabels(prompt, {
                questionToolCallId: prompt.toolCallId,
                selectedOptionIds: selected,
                ...(otherText.trim() ? { otherText: otherText.trim() } : {}),
              })).join(", ")}
            </p>
            {selectedPrincipleLabels.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Principles: {selectedPrincipleLabels.join(", ")}
              </p>
            ) : null}
            {(response?.reasoning || reasoning.trim()) ? (
              <p className="text-xs text-muted-foreground">
                Reasoning: {response?.reasoning || reasoning.trim()}
              </p>
            ) : null}
            {decisionId ? (
              <div className="pt-0.5 text-xs" data-testid={`question-decision-${prompt.toolCallId}`}>
                <InlineReferenceText text={`Recorded as @decision:${decisionId}`} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
        {prompt.options.map((option) => (
          <OptionRow
            key={option.id}
            checked={selected.includes(option.id)}
            disabled={controlsDisabled}
            label={option.label}
            description={option.description}
            testId={`question-option-${prompt.toolCallId}-${option.id}`}
            onSelect={() => selectOption(option.id)}
          />
        ))}
        {prompt.allowOther && (
          <div>
            <OptionRow
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
        )}
      </div>
      <div className="border-t border-border/40 px-2 py-2">
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => setShowProvenance((value) => !value)}
          className="px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          data-testid={`question-provenance-toggle-${prompt.toolCallId}`}
        >
          {showProvenance ? "Hide context" : "Add context"}
        </button>
        {showProvenance && (
          <div className="mt-1 space-y-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 px-2">
                <p className="text-xs text-muted-foreground">Which principles apply?</p>
                {principlesLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : null}
              </div>
              <input
                type="search"
                value={principleQuery}
                onChange={(event) => setPrincipleQuery(event.target.value)}
                disabled={controlsDisabled}
                placeholder="Search principles"
                className="w-full rounded-sm border border-border/30 bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border/60"
                data-testid={`question-principle-search-${prompt.toolCallId}`}
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
                    <OptionRow
                      key={principle.revisionId}
                      checked={selectedPrinciples.includes(principle.revisionId)}
                      disabled={controlsDisabled}
                      label={principle.title}
                      description={principle.layer1 || undefined}
                      testId={`question-principle-${prompt.toolCallId}-${principle.revisionId}`}
                      onSelect={() => togglePrinciple(principle.revisionId)}
                    />
                  ))
                )}
              </div>
            </div>
            {prompt.allowResponseReasoning && (
              <textarea
                value={reasoning}
                onChange={(event) => setReasoning(event.target.value)}
                disabled={controlsDisabled}
                rows={2}
                placeholder="Add your reasoning (optional)"
                className="w-full resize-none rounded-sm border border-border/30 bg-transparent p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border/60"
                data-testid={`question-reasoning-${prompt.toolCallId}`}
              />
            )}
          </div>
        )}
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
