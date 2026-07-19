import { createLogger } from "./log";
import type { ClassificationResult } from "./capture-classifier";

const log = createLogger("CaptureRouter");

export interface RouteResult {
  success: boolean;
  system: string;
  ref: string | null;
  error?: string;
}

async function getBridgeHandlers() {
  const { executeBridgeTool } = await import("./bridge-tools");
  return executeBridgeTool;
}

export async function routeCapture(
  classification: ClassificationResult,
  rawText: string
): Promise<RouteResult> {
  const executeBridgeTool = await getBridgeHandlers();

  try {
    switch (classification.type) {
      case "task": {
        const result = await executeBridgeTool("create_task", `capture-route-${Date.now()}`, {
          title: classification.summary,
          description: `From quick capture: ${rawText}`,
          priority: "mid",
          owner: "me",
        });
        if (result.error) {
          return { success: false, system: "tasks", ref: null, error: result.result };
        }
        const idMatch = result.result.match(/ID:\s*([^\s,)]+)/);
        return { success: true, system: "tasks", ref: idMatch?.[1] || "created" };
      }

      case "person_note": {
        if (!classification.person) {
          return { success: false, system: "people", ref: null, error: "No person identified in capture" };
        }
        const searchResult = await executeBridgeTool("people", `capture-search-${Date.now()}`, {
          action: "search",
          query: classification.person,
        });
        if (searchResult.error || searchResult.result.includes("No people matching") || searchResult.result.includes("0 result")) {
          return { success: false, system: "people", ref: null, error: `Could not find person: ${classification.person}` };
        }
        const personIdMatch = searchResult.result.match(/id:\s*([^\s,)]+)/i);
        if (!personIdMatch) {
          return { success: false, system: "people", ref: null, error: `Could not parse person ID from search` };
        }
        const noteResult = await executeBridgeTool("people", `capture-note-${Date.now()}`, {
          action: "add_note",
          id: personIdMatch[1],
          content: classification.summary,
        });
        if (noteResult.error) {
          return { success: false, system: "people", ref: null, error: noteResult.result };
        }
        return { success: true, system: "people", ref: personIdMatch[1] };
      }

      case "memory": {
        const result = await executeBridgeTool("library", `capture-memory-${Date.now()}`, {
          action: "create_library_page",
          title: classification.summary.slice(0, 80),
          plainTextContent: rawText,
          purpose: "quick-capture",
          pageContext: "/capture",
          contentSummary: classification.summary,
          tags: ["quick-capture", "memory"],
        });
        if (result.error) {
          return { success: false, system: "library", ref: null, error: result.result };
        }
        const idMatch = result.result.match(/\[([^\]]+)\]/);
        return { success: true, system: "library", ref: idMatch?.[1] || "created" };
      }

      case "idea": {
        const result = await executeBridgeTool("library", `capture-idea-${Date.now()}`, {
          action: "create_note",
          title: classification.summary.slice(0, 60),
          plainTextContent: rawText,
        });
        if (result.error) {
          return { success: false, system: "library", ref: null, error: result.result };
        }
        const idMatch = result.result.match(/\[(\d+)\]/);
        return { success: true, system: "library", ref: idMatch?.[1] || "created" };
      }

      case "reminder": {
        const timeNote = classification.timeRef ? ` [Due: ${classification.timeRef}]` : "";
        const result = await executeBridgeTool("create_task", `capture-reminder-${Date.now()}`, {
          title: `${classification.summary}${timeNote}`,
          description: `From quick capture (reminder): ${rawText}${classification.timeRef ? `\nTime reference: ${classification.timeRef}` : ""}`,
          priority: "mid",
          owner: "me",
        });
        if (result.error) {
          return { success: false, system: "tasks", ref: null, error: result.result };
        }
        const idMatch = result.result.match(/ID:\s*([^\s,)]+)/);
        return { success: true, system: "tasks", ref: idMatch?.[1] || "created" };
      }

      case "calendar": {
        if (!classification.timeRef) {
          return { success: false, system: "meetings", ref: null, error: "No time reference found for calendar event" };
        }
        const result = await executeBridgeTool("meetings", `capture-calendar-${Date.now()}`, {
          action: "add",
          summary: classification.summary,
          start: classification.timeRef,
          description: `From quick capture: ${rawText}`,
        });
        if (result.error) {
          return { success: false, system: "meetings", ref: null, error: result.result };
        }
        return { success: true, system: "meetings", ref: "created" };
      }

      default:
        return { success: false, system: "unknown", ref: null, error: `Unknown type: ${classification.type}` };
    }
  } catch (err: any) {
    log.error(`Routing failed for type ${classification.type}: ${err.message}`);
    return { success: false, system: classification.type, ref: null, error: err.message };
  }
}
