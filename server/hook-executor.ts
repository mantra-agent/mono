import type { BusEvent } from "./event-bus";
import { eventBus } from "./event-bus";
import type { SystemHook } from "@shared/schema";
import * as hookStorage from "./hook-storage";
import { persistEvent, cleanupOldEvents } from "./event-persistence";
import { createLogger } from "./log";

const log = createLogger("HookExecutor");

function matchEventPattern(pattern: string, eventName: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
  );
  return regex.test(eventName);
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function interpolateTemplates(obj: any, context: Record<string, any>): any {
  if (typeof obj === "string") {
    return obj.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const value = getNestedValue(context, path);
      return value !== undefined ? String(value) : `{{${path}}}`;
    });
  }
  if (Array.isArray(obj)) return obj.map(item => interpolateTemplates(item, context));
  if (obj && typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateTemplates(value, context);
    }
    return result;
  }
  return obj;
}

function matchCondition(condition: Record<string, any>, payload: Record<string, any>): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    const actual = getNestedValue(payload, key);
    if (actual !== expected) return false;
  }
  return true;
}

class HookExecutor {
  private hooks: SystemHook[] = [];
  private lastFired: Map<number, number> = new Map();
  private executionCounts: Map<number, number> = new Map();
  private executionsThisMinute = 0;
  private minuteResetTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`ALTER TABLE system_hooks ADD COLUMN IF NOT EXISTS max_firings integer`);
    } catch (err: any) {
      log.warn(`auto-heal max_firings column: ${err.message}`);
    }

    try {
      await this.refreshCache();
    } catch (err: any) {
      log.warn(`initial hook load failed: ${err.message}`);
    }

    for (const hook of this.hooks) {
      try {
        const lastExec = await hookStorage.getLastExecution(hook.id);
        if (lastExec) {
          this.lastFired.set(hook.id, new Date(lastExec.createdAt).getTime());
        }
      } catch { }
    }

    this.minuteResetTimer = setInterval(() => {
      this.executionsThisMinute = 0;
    }, 60_000);

    setTimeout(() => {
      cleanupOldEvents(7).catch(err => log.warn(`initial event cleanup failed: ${err.message}`));
    }, 60_000);

    this.cleanupTimer = setInterval(() => {
      cleanupOldEvents(7).catch(err => log.warn(`event cleanup failed: ${err.message}`));
    }, 24 * 60 * 60 * 1000);

    eventBus.on("event", (busEvent: BusEvent) => {
      this.handleEvent(busEvent).catch(err => {
        log.warn(`hook evaluation failed event=${busEvent.event}: ${err.message}`);
      });
    });

    log.log(`initialized hooks=${this.hooks.length}`);
  }

  async handleEvent(busEvent: BusEvent): Promise<void> {
    if (this.hooks.length === 0) return;

    if (this.executionsThisMinute >= 100) {
      return;
    }

    let eventDbId: number | undefined;
    let eventDbIdResolved = false;

    const matchingHooks: Array<{ hook: SystemHook }> = [];

    for (const hook of this.hooks) {
      if (!hook.enabled) continue;

      try {
        if (!matchEventPattern(hook.eventPattern, busEvent.event)) continue;

        if (hook.condition && typeof hook.condition === "object" && Object.keys(hook.condition).length > 0) {
          if (!matchCondition(hook.condition as Record<string, any>, busEvent.payload || {})) continue;
        }

        if (hook.cooldownSeconds > 0) {
          const lastTime = this.lastFired.get(hook.id);
          if (lastTime && (Date.now() - lastTime) < hook.cooldownSeconds * 1000) continue;
        }

        if (hook.maxFirings != null) {
          const count = this.executionCounts.get(hook.id) ?? 0;
          if (count >= hook.maxFirings) continue;
        }

        if (this.executionsThisMinute >= 100) break;
        matchingHooks.push({ hook });
      } catch (err: any) {
        log.warn(`hook evaluation error hook=${hook.name}: ${err.message}`);
      }
    }

    if (matchingHooks.length === 0) return;

    if (!eventDbIdResolved) {
      eventDbIdResolved = true;
      try {
        const { getEventByEventId } = await import("./event-persistence");
        for (let attempt = 0; attempt < 3; attempt++) {
          const dbEvent = await getEventByEventId(busEvent.id);
          if (dbEvent) {
            eventDbId = dbEvent.dbId;
            break;
          }
          await new Promise(r => setTimeout(r, 50));
        }
      } catch { }
    }

    const context: Record<string, any> = {
      payload: busEvent.payload || {},
      event: busEvent.event,
      category: busEvent.category,
      eventId: busEvent.id,
      runId: busEvent.runId || "",
      timestamp: busEvent.timestamp,
    };

    for (const { hook } of matchingHooks) {
      try {
        const resolvedConfig = interpolateTemplates(
          JSON.parse(JSON.stringify(hook.actionConfig)),
          context
        );

        this.lastFired.set(hook.id, Date.now());
        this.executionCounts.set(hook.id, (this.executionCounts.get(hook.id) ?? 0) + 1);
        this.executionsThisMinute++;

        this.dispatchAction(hook, resolvedConfig, eventDbId).catch(err => {
          log.error(`dispatch contract failed hook=${hook.name} action=${hook.actionType}: ${err.message}`);
        });
      } catch (err: any) {
        log.warn(`hook dispatch error hook=${hook.name}: ${err.message}`);
        hookStorage.recordExecution({
          hookId: hook.id,
          eventDbId,
          actionType: hook.actionType,
          status: "error",
          errorMessage: err.message,
        }).catch(() => { });
      }
    }
  }

  private async dispatchAction(hook: SystemHook, resolvedConfig: any, eventDbId?: number): Promise<void> {
    const startTime = Date.now();
    let status = "dispatched";
    let errorMessage: string | undefined;

    try {
      switch (hook.actionType) {
        case "run_skill": {
          const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");
          const skillId = resolvedConfig.skillId || resolvedConfig.skillName;
          if (!skillId) throw new Error("missing skillId/skillName in action config");
          executeAutonomousSkillRun(skillId, {
            preContext: resolvedConfig.preContext || undefined,
            hookTriggerId: String(hook.id),
            hookTriggerName: hook.name,
          }).catch(err => {
            log.error(`skill run dispatch failed hook=${hook.name} skill=${skillId}: ${err.message}`);
          });
          status = "dispatched";
          break;
        }
        case "initiate_conversation": {
          const { executeBridgeTool } = await import("./bridge-tools");
          const topic = resolvedConfig.topic || "Hook-triggered conversation";
          const message = resolvedConfig.message || "";
          await executeBridgeTool("converse", `hook-${hook.id}-${Date.now()}`, {
            action: "initiate",
            topic,
            message,
          });
          status = "success";
          break;
        }
        case "tool_call": {
          const { executeBridgeTool } = await import("./bridge-tools");
          const toolName = resolvedConfig.toolName;
          if (!toolName) throw new Error("missing toolName in action config");
          await executeBridgeTool(toolName, `hook-${hook.id}-${Date.now()}`, resolvedConfig.arguments || {});
          status = "success";
          break;
        }
        default:
          throw new Error(`unknown action type: ${hook.actionType}`);
      }
    } catch (err: any) {
      status = "error";
      errorMessage = err.message;
      log.error(`hook action failed hook=${hook.name} action=${hook.actionType}: ${err.message}`);
    }

    const durationMs = Date.now() - startTime;

    // Record execution first, then check if we should consume.
    // Previously fire-and-forget — countExecutions raced ahead of the write
    // and always returned 0, so maxFirings deletion never triggered.
    try {
      await hookStorage.recordExecution({
        hookId: hook.id,
        eventDbId,
        actionType: hook.actionType,
        actionConfigResolved: resolvedConfig,
        status,
        errorMessage,
        durationMs,
      });
    } catch (err: any) {
      log.error(`hook execution persistence failed hook=${hook.name} action=${hook.actionType} status=${status}: ${err.message}`);
    }

    if (hook.maxFirings != null) {
      try {
        const count = await hookStorage.countExecutions(hook.id);
        if (count >= hook.maxFirings!) {
          await hookStorage.deleteHook(hook.id);
          this.invalidateCache();
          log.log(`[HookExecutor] Hook "${hook.name}" reached maxFirings=${hook.maxFirings}, consumed and deleted`);
        }
      } catch (err: any) {
        log.error(`maxFirings enforcement failed hook=${hook.name} hookId=${hook.id}: ${err.message}`);
      }
    }
  }

  async refreshCache(): Promise<void> {
    try {
      this.hooks = await hookStorage.listHooks();
      this.executionCounts.clear();
    } catch (err: any) {
      log.warn(`hook cache refresh failed: ${err.message}`);
    }
  }

  invalidateCache(): void {
    this.refreshCache().catch(err => log.warn(`cache invalidation failed: ${err.message}`));
  }

  testHook(hook: { eventPattern: string; condition?: any; actionConfig: any }, busEvent: BusEvent): {
    matches: boolean;
    resolvedConfig: any;
    patternMatch: boolean;
    conditionMatch: boolean;
  } {
    const patternMatch = matchEventPattern(hook.eventPattern, busEvent.event);
    let conditionMatch = true;
    if (hook.condition && typeof hook.condition === "object" && Object.keys(hook.condition).length > 0) {
      conditionMatch = matchCondition(hook.condition as Record<string, any>, busEvent.payload || {});
    }

    const context: Record<string, any> = {
      payload: busEvent.payload || {},
      event: busEvent.event,
      category: busEvent.category,
      eventId: busEvent.id,
      runId: busEvent.runId || "",
      timestamp: busEvent.timestamp,
    };

    const resolvedConfig = interpolateTemplates(
      JSON.parse(JSON.stringify(hook.actionConfig)),
      context
    );

    return {
      matches: patternMatch && conditionMatch,
      resolvedConfig,
      patternMatch,
      conditionMatch,
    };
  }
}

export const hookExecutor = new HookExecutor();
