import type { SystemHook } from "@shared/schema";
import type { BusEvent } from "./event-bus";
import { eventBus, isEventVisibleToPrincipal } from "./event-bus";
import * as hookStorage from "./hook-storage";
import { createLogger } from "./log";
import { getUserEffectivePermissions } from "./permissions";
import {
  createNamedSystemPrincipal,
  createUserPrincipalFromUser,
  tryResolveUserIdentityFoundation,
  type Principal,
} from "./principal";
import { runWithPrincipal } from "./principal-context";
import { storage } from "./storage";

const log = createLogger("HookExecutor");
const MAX_EXECUTIONS_PER_MINUTE = 100;

type HookActionResult = {
  status: "dispatched" | "success" | "error";
  errorMessage?: string;
};

function matchEventPattern(pattern: string, eventName: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return regex.test(eventName);
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function interpolateTemplates(obj: unknown, context: Record<string, unknown>): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
      const value = getNestedValue(context, path);
      return value !== undefined ? String(value) : `{{${path}}}`;
    });
  }
  if (Array.isArray(obj)) return obj.map((item) => interpolateTemplates(item, context));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => [key, interpolateTemplates(value, context)]),
    );
  }
  return obj;
}

function matchCondition(condition: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return Object.entries(condition).every(([key, expected]) => getNestedValue(payload, key) === expected);
}

class HookExecutor {
  private hooks: SystemHook[] = [];
  private executionsThisMinute = 0;
  private minuteResetTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private executionQueue: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await runWithPrincipal(createNamedSystemPrincipal("hook-executor"), () => this.refreshCache());
    } catch (error) {
      log.warn(`initial hook load failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.minuteResetTimer = setInterval(() => {
      this.executionsThisMinute = 0;
    }, 60_000);
    this.minuteResetTimer.unref?.();

    eventBus.on("event", (busEvent: BusEvent) => {
      this.executionQueue = this.executionQueue
        .then(() => this.handleEvent(busEvent))
        .catch((error) => {
          log.warn(`hook evaluation failed event=${busEvent.event}: ${error instanceof Error ? error.message : String(error)}`);
        });
    });

    log.info("hook.executor.initialized", { hooks: this.hooks.length, concurrency: 1 });
  }

  async handleEvent(busEvent: BusEvent): Promise<void> {
    if (this.hooks.length === 0 || this.executionsThisMinute >= MAX_EXECUTIONS_PER_MINUTE) return;

    const context: Record<string, unknown> = {
      payload: busEvent.payload || {},
      event: busEvent.event,
      category: busEvent.category,
      eventId: busEvent.id,
      runId: busEvent.runId || "",
      timestamp: busEvent.timestamp,
    };

    for (const hook of this.hooks) {
      if (this.executionsThisMinute >= MAX_EXECUTIONS_PER_MINUTE) break;
      if (!hook.enabled || !matchEventPattern(hook.eventPattern, busEvent.event)) continue;
      if (
        hook.condition &&
        typeof hook.condition === "object" &&
        Object.keys(hook.condition).length > 0 &&
        !matchCondition(hook.condition as Record<string, unknown>, busEvent.payload || {})
      ) continue;

      try {
        const principal = await this.resolveHookPrincipal(hook);
        if (!isEventVisibleToPrincipal(busEvent, principal)) continue;
        const resolvedConfig = interpolateTemplates(hook.actionConfig, context);
        const execution = await runWithPrincipal(principal, () => hookStorage.claimHookExecution({
          hookId: hook.id,
          eventIdentity: `${busEvent.bootId ?? "unknown"}:${busEvent.id}`,
          actionType: hook.actionType,
          actionConfigResolved: resolvedConfig,
        }));
        if (!execution) continue;

        this.executionsThisMinute++;
        const startedAt = Date.now();
        const result = await runWithPrincipal(principal, async () => {
          if (hook.actionType === "run_skill") return this.dispatchAction(hook, resolvedConfig);
          const { admissionController } = await import("./run-admission");
          return admissionController.withResourcePool(
            "short_worker",
            `hook:${hook.id}:${execution.id}`,
            () => this.dispatchAction(hook, resolvedConfig),
            { activity: `hook.${hook.actionType}` },
          );
        }).catch((error): HookActionResult => ({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }));

        const completion = await runWithPrincipal(principal, () => hookStorage.completeHookExecution({
          hookId: hook.id,
          executionId: execution.id,
          status: result.status,
          errorMessage: result.errorMessage,
          durationMs: Date.now() - startedAt,
        }));
        if (completion.disabled) this.invalidateCache();
      } catch (error) {
        log.warn(`hook dispatch error hook=${hook.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async dispatchAction(hook: SystemHook, resolvedConfigValue: unknown): Promise<HookActionResult> {
    const resolvedConfig = resolvedConfigValue && typeof resolvedConfigValue === "object"
      ? resolvedConfigValue as Record<string, unknown>
      : {};
    try {
      switch (hook.actionType) {
        case "run_skill": {
          const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");
          const skillId = resolvedConfig.skillId || resolvedConfig.skillName;
          if (typeof skillId !== "string" || !skillId.trim()) throw new Error("missing skillId/skillName in action config");
          void executeAutonomousSkillRun(skillId, {
            preContext: typeof resolvedConfig.preContext === "string" ? resolvedConfig.preContext : undefined,
            hookTriggerId: String(hook.id),
            hookTriggerName: hook.name,
          }).catch((error) => {
            log.error(`skill run dispatch failed hook=${hook.name} skill=${skillId}: ${error instanceof Error ? error.message : String(error)}`);
          });
          return { status: "dispatched" };
        }
        case "initiate_conversation": {
          const { executeBridgeTool } = await import("./bridge-tools");
          await executeBridgeTool("converse", `hook-${hook.id}-${Date.now()}`, {
            action: "initiate",
            topic: typeof resolvedConfig.topic === "string" ? resolvedConfig.topic : "Hook-triggered conversation",
            message: typeof resolvedConfig.message === "string" ? resolvedConfig.message : "",
          }, { sessionKey: `hook:${hook.id}`, sessionId: "", authority: { origin: "hook" } });
          return { status: "success" };
        }
        case "tool_call": {
          const { executeBridgeTool } = await import("./bridge-tools");
          const toolName = resolvedConfig.toolName;
          if (typeof toolName !== "string" || !toolName.trim()) throw new Error("missing toolName in action config");
          const args = resolvedConfig.arguments && typeof resolvedConfig.arguments === "object"
            ? resolvedConfig.arguments as Record<string, unknown>
            : {};
          await executeBridgeTool(toolName, `hook-${hook.id}-${Date.now()}`, args, {
            sessionKey: `hook:${hook.id}`,
            sessionId: "",
            authority: { origin: "hook" },
          });
          return { status: "success" };
        }
        default:
          throw new Error(`unknown action type: ${hook.actionType}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`hook action failed hook=${hook.name} action=${hook.actionType}: ${errorMessage}`);
      return { status: "error", errorMessage };
    }
  }

  private async resolveHookPrincipal(hook: SystemHook): Promise<Principal> {
    if (hook.scope === "system") return createNamedSystemPrincipal(`hook:${hook.id}`);
    if (hook.scope !== "user" || !hook.ownerUserId || !hook.accountId) {
      throw new Error(`Hook ${hook.id} is not executable because ownership is unresolved`);
    }
    const user = await storage.getUser(hook.ownerUserId);
    if (!user) throw new Error(`Hook owner user missing: ${hook.ownerUserId}`);
    const foundation = await tryResolveUserIdentityFoundation(user.id);
    const principal = createUserPrincipalFromUser(
      user,
      hook.accountId,
      foundation?.accountId === hook.accountId ? foundation.instanceId : null,
    );
    principal.permissions = await getUserEffectivePermissions(user.id);
    return principal;
  }

  async refreshCache(): Promise<void> {
    this.hooks = await hookStorage.listHooksForScheduler();
  }

  invalidateCache(): void {
    void runWithPrincipal(createNamedSystemPrincipal("hook-executor"), () => this.refreshCache())
      .catch((error) => log.warn(`cache invalidation failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  testHook(hook: { eventPattern: string; condition?: unknown; actionConfig: unknown }, busEvent: BusEvent): {
    matches: boolean;
    resolvedConfig: unknown;
    patternMatch: boolean;
    conditionMatch: boolean;
  } {
    const patternMatch = matchEventPattern(hook.eventPattern, busEvent.event);
    const conditionMatch = !hook.condition || typeof hook.condition !== "object" || Object.keys(hook.condition).length === 0
      ? true
      : matchCondition(hook.condition as Record<string, unknown>, busEvent.payload || {});
    const context: Record<string, unknown> = {
      payload: busEvent.payload || {},
      event: busEvent.event,
      category: busEvent.category,
      eventId: busEvent.id,
      runId: busEvent.runId || "",
      timestamp: busEvent.timestamp,
    };
    return {
      matches: patternMatch && conditionMatch,
      resolvedConfig: interpolateTemplates(hook.actionConfig, context),
      patternMatch,
      conditionMatch,
    };
  }
}

export const hookExecutor = new HookExecutor();
