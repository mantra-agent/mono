import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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

export function QuestionWidget({
  prompt,
  response,
  disabled,
  onSubmit,
}: {
  prompt: QuestionWidgetPrompt;
  response?: QuestionResponseMeta;
  disabled?: boolean;
  onSubmit?: (response: QuestionResponseMeta) => Promise<boolean>;
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

  const chooseSingle = (value: string) => {
    setError(null);
    if (value === "__other__") {
      setSelected([]);
      setOtherSelected(true);
      return;
    }
    setSelected([value]);
    setOtherSelected(false);
    setOtherText("");
  };

  const toggleMultiple = (optionId: string, checked: boolean) => {
    setError(null);
    setSelected((current) => checked
      ? [...current.filter((id) => id !== optionId), optionId]
      : current.filter((id) => id !== optionId));
  };

  const submit = async () => {
    if (!onSubmit) return;
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
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card p-4" data-testid={`question-widget-${prompt.toolCallId}`}>
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10">
            <Check className="h-4 w-4 text-success" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{prompt.question}</p>
            <p className="mt-2 text-sm text-muted-foreground">{answeredLabels.join(", ")}</p>
          </div>
        </div>
      </div>
    );
  }

  const controlsDisabled = disabled || submitting;
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card p-4" data-testid={`question-widget-${prompt.toolCallId}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
          <MessageCircleQuestion className="h-4 w-4 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-6 text-foreground">{prompt.question}</p>
          {prompt.selectionMode === "single" ? (
            <RadioGroup
              className="mt-3 gap-2"
              value={otherSelected ? "__other__" : selected[0] ?? ""}
              onValueChange={chooseSingle}
              disabled={controlsDisabled}
            >
              {prompt.options.map((option) => (
                <label key={option.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent">
                  <RadioGroupItem value={option.id} className="mt-0.5" />
                  <span className="min-w-0 text-sm">
                    <span className="block text-foreground">{option.label}</span>
                    {option.description && <span className="mt-0.5 block text-muted-foreground">{option.description}</span>}
                  </span>
                </label>
              ))}
              {prompt.allowOther && (
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent">
                  <RadioGroupItem value="__other__" className="mt-0.5" />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block text-foreground">Other</span>
                    {otherSelected && (
                      <textarea
                        autoFocus
                        value={otherText}
                        onChange={(event) => setOtherText(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        disabled={controlsDisabled}
                        rows={2}
                        placeholder="Add your answer"
                        className="mt-2 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    )}
                  </span>
                </label>
              )}
            </RadioGroup>
          ) : (
            <div className="mt-3 space-y-2">
              {prompt.options.map((option) => {
                const checked = selected.includes(option.id);
                return (
                  <label key={option.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) => toggleMultiple(option.id, value === true)}
                      disabled={controlsDisabled}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block text-foreground">{option.label}</span>
                      {option.description && <span className="mt-0.5 block text-muted-foreground">{option.description}</span>}
                    </span>
                  </label>
                );
              })}
              {prompt.allowOther && (
                <div className="rounded-lg border border-border px-3 py-2.5">
                  <label className="flex min-h-6 cursor-pointer items-start gap-3">
                    <Checkbox
                      checked={otherSelected}
                      onCheckedChange={(value) => {
                        setOtherSelected(value === true);
                        setError(null);
                        if (value !== true) setOtherText("");
                      }}
                      disabled={controlsDisabled}
                      className="mt-0.5"
                    />
                    <span className="text-sm text-foreground">Other</span>
                  </label>
                  {otherSelected && (
                    <textarea
                      autoFocus
                      value={otherText}
                      onChange={(event) => setOtherText(event.target.value)}
                      disabled={controlsDisabled}
                      rows={2}
                      placeholder="Add your answer"
                      className="mt-2 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  )}
                </div>
              )}
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className={cn("text-sm", error ? "text-error" : "text-muted-foreground")}>
              {error ?? (prompt.selectionMode === "multiple" ? "Choose all that apply." : "Choose one.")}
            </p>
            <Button
              type="button"
              className="min-h-11 bg-cta text-cta-foreground hover:bg-cta/90"
              disabled={controlsDisabled}
              onClick={submit}
              data-testid={`button-answer-question-${prompt.toolCallId}`}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Answer"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
