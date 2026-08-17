// Use createLogger for logging ONLY
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { emitSessionChanged, emitSessionListChanged } from "@/hooks/use-data-sync";
import { useToast } from "@/hooks/use-toast";
import { resolvePersonaIcon } from "@/lib/persona-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Pin, Sparkles } from "lucide-react";
import type { ChatSession } from "@shared/models/chat";
import type { ContextPressureSnapshot } from "@shared/streaming-types";

interface PersonaOption {
  id: number;
  name: string;
  icon: string;
  description?: string;
}

interface AgentPersonaControlProps {
  sessionId: string;
  /** The persona frozen on this assistant turn — drives the icon shown. */
  persona?: { id: number; name: string; icon: string } | null;
  contextPressure?: ContextPressureSnapshot | null;
}

/**
 * The assistant avatar as a control: hover to read the active persona, click to
 * pick one for this conversation. Picking a persona pins it (the agent stops
 * auto-switching for this session); picking Auto hands the dial back to the agent.
 * Mirrors the session-scoped model-tier override pattern in the bottom bar.
 */
export function AgentPersonaControl({ sessionId, persona, contextPressure }: AgentPersonaControlProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  // Read (don't fetch) the sessions cache so pin state stays reactive.
  const { data: sessions } = useQuery<ChatSession[]>({ queryKey: ["/api/sessions"], enabled: false });
  const session = sessions?.find((s) => s.id === sessionId);
  const pinned = Boolean(session?.personaPinnedByUser);
  const activePersonaId = session?.personaId ?? persona?.id ?? null;

  // Load personas when the menu opens, or when we need the session seat icon
  // before the turn snapshot / stream model_info arrives.
  const needsSessionPersonaFallback = !persona && activePersonaId != null;
  const { data: personas } = useQuery<PersonaOption[]>({
    queryKey: ["/api/personas"],
    enabled: open || needsSessionPersonaFallback,
  });
  const sessionPersona = needsSessionPersonaFallback
    ? personas?.find((p) => p.id === activePersonaId) ?? null
    : null;
  const displayPersona = persona ?? (sessionPersona
    ? { id: sessionPersona.id, name: sessionPersona.name, icon: sessionPersona.icon }
    : null);

  const PersonaIcon = resolvePersonaIcon(displayPersona?.icon);
  const personaLabel = displayPersona?.name || "Choosing seat";
  const radioValue = pinned && activePersonaId != null ? String(activePersonaId) : "auto";
  // The message snapshot is historical; session pin state is current. Only show
  // the current pin when this turn's persona still matches the pinned persona.
  const showPinnedIcon = pinned && displayPersona?.id === activePersonaId;
  const formatTokensK = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k` : `${n}`;
  // Hover and ring share the usable hard-input envelope 1:1.
  // Strip billing-path suffix — "(Subscription)" adds no decision value in the hover.
  const modelLabel = contextPressure?.modelName
    ?.replace(/\s*\(Subscription\)\s*$/i, "")
    .trim();
  const pressureDetail =
    contextPressure && contextPressure.hardInputLimit
      ? ` (${formatTokensK(contextPressure.inputTokens)} / ${formatTokensK(
          contextPressure.hardInputLimit,
        )} · ${Math.round(
          (contextPressure.inputTokens / contextPressure.hardInputLimit) * 100,
        )}%${modelLabel ? ` · ${modelLabel}` : ""})`
      : "";
  // The client projects server-resolved altitudes onto the usable input envelope.
  // It owns no pressure policy and performs no threshold multiplication.
  const scaleLimit = contextPressure ? Math.max(contextPressure.hardInputLimit, 1) : 1;
  const ratio = (tokens: number | undefined) =>
    typeof tokens === "number" ? Math.min(tokens / scaleLimit, 1) : 0;
  const pressureRatio = ratio(contextPressure?.inputTokens);
  const toolSoftTrimRatio = ratio(contextPressure?.midTurnToolSoftTrim);
  const historyHardTrimRatio = ratio(contextPressure?.midTurnHistoryHardTrim);
  const historyResetRatio = ratio(contextPressure?.midTurnHistoryReset);
  const betweenTurnRatio = ratio(contextPressure?.betweenTurnHistoryReset);
  const pressureColor =
    contextPressure && contextPressure.inputTokens >= contextPressure.hardInputLimit
      ? "hsl(var(--destructive))"
      : contextPressure && contextPressure.inputTokens >= contextPressure.betweenTurnHistoryReset
        ? "hsl(var(--warning))"
        : "hsl(var(--cta))";
  const circumference = 2 * Math.PI * 18;

  const mutation = useMutation({
    mutationFn: async (nextPersonaId: number | null) => {
      await apiRequest("PATCH", `/api/sessions/${sessionId}/persona`, {
        personaId: nextPersonaId,
      });
      return nextPersonaId;
    },
    onMutate: async (nextPersonaId) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const prev = queryClient.getQueryData<ChatSession[]>(["/api/sessions"]);
      const patch = (s: ChatSession): ChatSession =>
        s.id === sessionId
          ? {
              ...s,
              personaPinnedByUser: nextPersonaId !== null,
              personaId: nextPersonaId !== null ? nextPersonaId : s.personaId,
            }
          : s;
      queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => old?.map(patch));
      queryClient.setQueryData<ChatSession>(["/api/sessions", sessionId], (old) =>
        old ? patch(old) : old,
      );
      return { prev };
    },
    onError: (err, _next, context) => {
      if (context?.prev) queryClient.setQueryData(["/api/sessions"], context.prev);
      toast({ title: "Failed to update persona", description: String(err), variant: "destructive" });
    },
    onSuccess: () => {
      emitSessionChanged(sessionId, "persona-pin");
      emitSessionListChanged("persona-pin");
    },
  });

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Persona: ${personaLabel}. Click to change the persona for this conversation.`}
              data-testid={`button-agent-persona-${sessionId}`}
            >
              {contextPressure && (
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 -rotate-90 overflow-visible"
                  viewBox="0 0 40 40"
                  data-testid={`context-pressure-ring-${sessionId}`}
                >
                  <circle cx="20" cy="20" r="18" fill="none" stroke="hsl(var(--border))" strokeOpacity="0.45" strokeWidth="1.5" />
                  <circle
                    cx="20"
                    cy="20"
                    r="18"
                    fill="none"
                    stroke={pressureColor}
                    strokeLinecap="round"
                    strokeWidth="1.5"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - pressureRatio)}
                    className="transition-[stroke,stroke-dashoffset] duration-300 ease-out"
                  />
                  {toolSoftTrimRatio > 0 && toolSoftTrimRatio < 1 && (
                    <circle
                      cx="38"
                      cy="20"
                      r="1.25"
                      fill="hsl(var(--warning))"
                      fillOpacity="0.55"
                      transform={`rotate(${toolSoftTrimRatio * 360} 20 20)`}
                    />
                  )}
                  {historyHardTrimRatio > 0 && historyHardTrimRatio < 1 && (
                    <circle
                      cx="38"
                      cy="20"
                      r="1.25"
                      fill="hsl(var(--warning))"
                      fillOpacity="0.78"
                      transform={`rotate(${historyHardTrimRatio * 360} 20 20)`}
                    />
                  )}
                  {historyResetRatio > 0 && historyResetRatio < 1 && (
                    <circle
                      cx="38"
                      cy="20"
                      r="1.4"
                      fill="hsl(var(--warning))"
                      transform={`rotate(${historyResetRatio * 360} 20 20)`}
                    />
                  )}
                  {betweenTurnRatio > 0 && betweenTurnRatio < 1 && (
                    <line
                      x1="36.5"
                      y1="20"
                      x2="39.5"
                      y2="20"
                      stroke="hsl(var(--muted-foreground))"
                      strokeWidth="1"
                      strokeLinecap="round"
                      opacity="0.55"
                      transform={`rotate(${betweenTurnRatio * 360} 20 20)`}
                    />
                  )}
                </svg>
              )}
              <PersonaIcon className="h-4 w-4 text-primary" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="inline-flex items-center gap-1">
            {showPinnedIcon && (
              <Pin
                className="h-3 w-3 shrink-0 text-white"
                fill="currentColor"
                aria-label="Pinned"
              />
            )}
            <span>
              {personaLabel}
              {pressureDetail}
            </span>
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup
          value={radioValue}
          onValueChange={(value) => {
            const next = value === "auto" ? null : Number(value);
            if (next === (pinned ? activePersonaId : null)) return;
            mutation.mutate(next);
          }}
        >
          <DropdownMenuRadioItem value="auto" className="gap-2">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Auto</span>
          </DropdownMenuRadioItem>
          {(personas ?? []).map((p) => {
            const Icon = resolvePersonaIcon(p.icon);
            return (
              <DropdownMenuRadioItem key={p.id} value={String(p.id)} className="gap-2">
                <Icon className="h-3.5 w-3.5 text-primary" />
                <span>{p.name}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
