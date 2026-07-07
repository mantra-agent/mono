import type {
  SurfaceDescriptor,
  ComponentDescriptor,
  CortexReasoning,
} from "@shared/models/glasses";
import { getCalendarContext } from "./sources/calendar";
import { getHealthContext } from "./sources/health";
import { getPrioritiesContext } from "./sources/priorities";
import { getWeatherContext } from "./sources/weather";
import { getFinanceContext } from "./sources/finance";
import { createLogger } from "../log";

const log = createLogger("Cortex");

const SOURCE_TIMEOUT_MS = 2000;
const MAX_COMPONENTS = 3;

function withTimeout(
  promise: Promise<string>,
  ms: number,
  fallback: string,
): Promise<string> {
  return Promise.race([
    promise,
    new Promise<string>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function buildContextSnapshot(sources: Record<string, string>): string {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });

  const lines = [
    `Current time: ${dayOfWeek}, ${timeStr} CT`,
    "",
    ...Object.entries(sources).map(
      ([name, context]) => `[${name}]\n${context}`,
    ),
  ];

  return lines.join("\n\n");
}

const CORTEX_SYSTEM_PROMPT = `You are the Cortex — the ambient intelligence behind a glasses display surface. Your job is to reason over a complete context snapshot and decide what, if anything, deserves the user's attention right now.

Rules:
- "Nothing" is the correct answer most of the time. Only surface something if it is genuinely time-sensitive or important enough to interrupt awareness.
- Return 0-3 items maximum. Fewer is better.
- A meeting starting in 5 minutes deserves attention. A meeting in 90 minutes does not.
- Overdue wellness activities are worth surfacing only if severely overdue (danger zone).
- Severe weather alerts always surface.
- Financial alerts surface only if critically low.
- Never surface "set your priorities" prompts — that's nagging, not intelligence.

Respond with valid JSON matching this schema:
{
  "reasoning": "Brief explanation of your decision",
  "decision": "nothing" | "surface",
  "components": [] // Array of 0-3 ComponentDescriptor objects
}

Each ComponentDescriptor has:
{
  "type": "TextCard" | "ActionCard" | "ListCard" | "TimerCard" | "AlertCard" | "TransitionCard",
  "id": "unique-string",
  "focusable": boolean,
  "props": { ... } // type-specific props
}

TextCard props: { title: string, subtitle?: string, icon?: string, urgency?: "low"|"medium"|"high"|"critical" }
AlertCard props: { message: string, severity: "info"|"warning"|"critical", dismissible: boolean }
ListCard props: { title: string, items: [{label: string, meta?: string}], maxVisible?: number }
TimerCard props: { label: string, targetTime: "ISO string", format: "countdown"|"elapsed"|"time" }

When decision is "nothing", components must be an empty array.`;

interface CortexLLMResponse {
  reasoning: string;
  decision: "nothing" | "surface";
  components: ComponentDescriptor[];
}

export interface EvaluateOptions {
  debug?: boolean;
}

export async function evaluateSurface(
  options?: EvaluateOptions,
): Promise<SurfaceDescriptor> {
  const startTime = Date.now();

  // Gather context from all sources in parallel
  const results = await Promise.allSettled([
    withTimeout(getCalendarContext(), SOURCE_TIMEOUT_MS, "Calendar timed out."),
    withTimeout(getHealthContext(), SOURCE_TIMEOUT_MS, "Health timed out."),
    withTimeout(
      getPrioritiesContext(),
      SOURCE_TIMEOUT_MS,
      "Priorities timed out.",
    ),
    withTimeout(getWeatherContext(), SOURCE_TIMEOUT_MS, "Weather timed out."),
    withTimeout(getFinanceContext(), SOURCE_TIMEOUT_MS, "Finance timed out."),
  ]);

  const sourceNames = [
    "Calendar",
    "Health",
    "Priorities",
    "Weather",
    "Finance",
  ];
  const sources: Record<string, string> = {};

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      sources[sourceNames[i]] = result.value;
    } else {
      sources[sourceNames[i]] = `Error: ${result.reason}`;
      log.warn(`Source ${sourceNames[i]} failed: ${result.reason}`);
    }
  });

  const contextSnapshot = buildContextSnapshot(sources);

  // Call LLM to reason over context
  let llmResponse: CortexLLMResponse;
  let modelUsed = "unknown";

  try {
    const { chatCompletion } = await import("../model-client");
    const { ACTIVITY_FRAMING } = await import("../job-profiles");

    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      maxTokens: 1000,
      messages: [
        { role: "system", content: CORTEX_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Here is the complete context snapshot. What, if anything, deserves attention right now?\n\n${contextSnapshot}`,
        },
      ],
      temperature: 0.3,
      jsonMode: true,
      metadata: { source: "glasses-cortex", activity: ACTIVITY_FRAMING },
    });

    modelUsed = `${result.provider}/${result.model}`;

    // Parse JSON response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }
    llmResponse = JSON.parse(jsonMatch[0]) as CortexLLMResponse;

    // Enforce max components
    if (llmResponse.components.length > MAX_COMPONENTS) {
      llmResponse.components = llmResponse.components.slice(0, MAX_COMPONENTS);
    }
  } catch (err) {
    log.error(`Cortex LLM call failed: ${(err as Error).message}`);
    // Fallback: return empty canvas on LLM failure
    llmResponse = {
      reasoning: `LLM call failed: ${(err as Error).message}`,
      decision: "nothing",
      components: [],
    };
  }

  const elapsed = Date.now() - startTime;
  log.log(
    `Cortex evaluated → ${llmResponse.decision} (${llmResponse.components.length} components, ${elapsed}ms, model=${modelUsed})`,
  );

  const reasoning: CortexReasoning = {
    contextSnapshot,
    reasoning: llmResponse.reasoning,
    decision: llmResponse.decision,
    computedAt: new Date().toISOString(),
    modelUsed,
    sessionOwned: false,
  };

  const descriptor: SurfaceDescriptor = {
    version: 1,
    timestamp: new Date().toISOString(),
    components: llmResponse.components,
  };

  // Always include reasoning when debug, otherwise include a lightweight version
  if (options?.debug) {
    descriptor.reasoning = reasoning;
  } else {
    descriptor.reasoning = {
      ...reasoning,
      contextSnapshot: "", // Strip full context in non-debug mode to save bandwidth
    };
  }

  return descriptor;
}
