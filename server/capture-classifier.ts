import { chatCompletion } from "./model-client";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { createLogger } from "./log";
import { extractJson } from "./utils/extract-json";

const log = createLogger("CaptureClassifier");

export interface ClassificationResult {
  type: "task" | "person_note" | "memory" | "idea" | "reminder" | "calendar";
  confidence: number;
  person: string | null;
  timeRef: string | null;
  summary: string;
}

const CLASSIFICATION_PROMPT = `You are a capture classifier. Given a short text input, classify it into exactly one type.

Types:
- task: Something the user needs to do. Action-oriented. ("Buy diapers", "Follow up with Connor")
- person_note: Information about a specific person. ("Mom sent $300 for Thea", "Jared is going to Guatemala")
- memory: Something worth remembering that isn't about a person or a task. ("Thea smiled for the first time", "Anna and I had our first cafe outing with Thea")
- idea: A thought, concept, or possibility to explore later. ("What if we pitched RCCI on a longer contract", "Blog post about spatial computing and consciousness")
- reminder: A task with a specific time reference. ("Remind me to ask Mike about SSL cert Monday", "Check on settlement Wednesday")
- calendar: Something to schedule as an event. ("Dinner with Cam and Big J April 8", "Schedule dentist appointment next week")

If the text mentions a specific person by name AND is primarily about that person, classify as person_note.
If the text has an explicit time reference AND requires action, classify as reminder over task.
If the text is purely a future event, classify as calendar.

Respond with JSON only:
{
  "type": "task|person_note|memory|idea|reminder|calendar",
  "confidence": 0.0-1.0,
  "person": "name or null",
  "timeRef": "extracted time or null",
  "summary": "cleaned up version"
}`;

export async function classifyCapture(
  rawText: string,
  typeHint?: string | null
): Promise<ClassificationResult> {
  const userContent = typeHint
    ? `[Hint: the user suggested this might be a "${typeHint}"]\n\nText: "${rawText}"`
    : `Text: "${rawText}"`;

  try {
    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      maxTokens: 300,
      jsonMode: true,
      metadata: { source: "capture-classifier", activity: ACTIVITY_FRAMING },
      messages: [
        { role: "system", content: CLASSIFICATION_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const parsed = JSON.parse(extractJson(result.content));

    const validTypes = ["task", "person_note", "memory", "idea", "reminder", "calendar"];
    if (!validTypes.includes(parsed.type)) {
      log.log(`Invalid classification type "${parsed.type}", defaulting to memory`);
      parsed.type = "memory";
      parsed.confidence = 0.3;
    }

    return {
      type: parsed.type,
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
      person: parsed.person || null,
      timeRef: parsed.timeRef || null,
      summary: parsed.summary || rawText,
    };
  } catch (err: any) {
    log.error(`Classification failed: ${err.message}`);
    throw new Error(`Classification failed: ${err.message}`);
  }
}
