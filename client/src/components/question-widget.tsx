import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import {
  normalizeQuestionPrompt,
  type QuestionPrompt,
  type QuestionResponseMeta,
} from "@shared/question-prompt";

const log = createLogger("QuestionWidget");

export interface QuestionWidgetPrompt extends QuestionPrompt {
  toolCallId: string;
}

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
  testId,
  onSelect,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
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
      <span className="min-w-0 text-sm text-foreground">{label}</span>
    </button>
  );
}

export function QuestionWidget({
  prompt,
  response,
  onSubmit,
}: {
  prompt: QuestionWidgetPrompt;
  response?: QuestionResponseMeta;
  onSubmit: (response: QuestionResponseMeta) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string[]>(response?.selectedOptionIds ?? []);
  const [otherSelected, setOtherSelected] = useState(Boolean(response?.otherText));
  const [otherText, setOtherText] = useState(response?.otherText ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!response) return;
    setSelected(response.selectedOptionIds);
    setOtherSelected(Boolean(response.otherText));
    setOtherText(response.otherText ?? "");
  }, [response]);

  const answeredLabels = useMemo(
    () => response ? responseLabels(prompt, response) : [],
    [prompt, response],
  );

  const isSingle = prompt.selectionMode === "single";

  const selectOption = (optionId: string) => {
    setError(null);
    if (isSingle) {
      setSelected([optionId]);
      setOtherSelected(false);
      setOtherText("");
      return;
    }
    setSelected((current) => current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId]);
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
    const nextResponse: QuestionResponseMeta = {
      questionToolCallId: prompt.toolCallId,
      selectedOptionIds: selected,
      ...(normalizedOther ? { otherText: normalizedOther } : {}),
    };
    try {
      const submitted = await onSubmit(nextResponse);
      if (!submitted) setError("Answer could not be submitted.");
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

  if (response) {
    return (
      <div className="-ml-10 border rounded-md border-success/40 bg-success/5 my-1" data-testid={`question-widget-${prompt.toolCallId}`}>
        <div className="flex items-start gap-2.5 px-3 py-2">
          <SimpleCheckCircle checked interactive={false} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">{prompt.question}</p>
            <p className="mt-1 text-xs text-muted-foreground">{answeredLabels.join(", ")}</p>
          </div>
        </div>
      </div>
    );
  }

  const controlsDisabled = submitting;
  return (
    <div className="-ml-10 border rounded-md border-border/60 bg-muted/20 my-1" data-testid={`question-widget-${prompt.toolCallId}`}>
      <div className="flex items-start gap-2 px-3 py-2 border-b border-border/40">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-active" />
        <p className="min-w-0 text-sm font-medium text-foreground">{prompt.question}</p>
      </div>
      <div className="space-y-0.5 px-2 py-2">
        {prompt.options.map((option) => (
          <OptionRow
            key={option.id}
            checked={selected.includes(option.id)}
            disabled={controlsDisabled}
            label={option.label}
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
      <div className={cn(
        "flex items-center gap-3 border-t border-border/40 px-3 py-2",
        error ? "justify-between" : "justify-end",
      )}>
        {error && <p className="text-xs text-error">{error}</p>}
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
  );
}
