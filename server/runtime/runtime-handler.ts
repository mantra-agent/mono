import type { Principal } from "../principal";
import type {
  RuntimeAttribution,
  RuntimeResourcePool,
  RuntimeRunOutcome,
} from "@shared/models/runtime";

export type RuntimeExecutorProfile =
  | "in_process_trusted"
  | "isolated_browser"
  | "ephemeral_untrusted_code";

export interface RuntimeAuthorizationDecision {
  allowed: boolean;
  reasonCode: string;
  decisionRef?: string;
}

export type RuntimeAttemptDecision =
  | {
      kind: "complete";
      outcome: RuntimeRunOutcome;
      reasonCode: string;
      attribution: RuntimeAttribution;
      outputRefs: string[];
      verificationLevel: "none" | "self_reported" | "observed" | "verified";
    }
  | {
      kind: "retry";
      failureClass: string;
      reasonCode: string;
      attribution: RuntimeAttribution;
      retryAt: Date;
    };

export interface RuntimeFence {
  accountId: string;
  runId: string;
  attemptId: string;
  leaseEpoch: number;
  leaseToken: string;
}

export interface RuntimeExecutionContext {
  fence: RuntimeFence;
  effectIdempotencyKey(effectName: string): string;
  heartbeat(usageDelta?: Record<string, number>): Promise<void>;
  appendEvidence(input: {
    eventType: "mutation" | "verification" | "failure" | "correction";
    reasonCode?: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface RuntimeInputSchema<Input> {
  parse(value: unknown): Input;
}

export interface RuntimeHandler<Input = unknown> {
  key: string;
  version: number;
  inputSchemaVersion: number;
  inputSchema: RuntimeInputSchema<Input>;
  resourcePool: RuntimeResourcePool;
  executorProfile: RuntimeExecutorProfile;
  requiredCapabilities: string[];
  authorize(principal: Principal, input: Input): Promise<RuntimeAuthorizationDecision>;
  execute(context: RuntimeExecutionContext, input: Input): Promise<RuntimeAttemptDecision>;
}

function registryKey(key: string, version: number): string {
  return `${key}@${version}`;
}

class RuntimeHandlerRegistry {
  private readonly handlers = new Map<string, RuntimeHandler<unknown>>();

  register<Input>(handler: RuntimeHandler<Input>): void {
    const key = handler.key.trim();
    if (!/^[a-z][a-z0-9_.-]{0,119}$/.test(key)) {
      throw new Error(`Invalid runtime handler key: ${handler.key}`);
    }
    if (!Number.isInteger(handler.version) || handler.version < 1) {
      throw new Error(`Invalid runtime handler version: ${handler.version}`);
    }
    if (!Number.isInteger(handler.inputSchemaVersion) || handler.inputSchemaVersion < 1) {
      throw new Error(`Invalid runtime input schema version: ${handler.inputSchemaVersion}`);
    }
    const identity = registryKey(key, handler.version);
    if (this.handlers.has(identity)) {
      throw new Error(`Runtime handler already registered: ${identity}`);
    }
    this.handlers.set(identity, handler as RuntimeHandler<unknown>);
  }

  get(key: string, version: number): RuntimeHandler<unknown> | null {
    return this.handlers.get(registryKey(key, version)) ?? null;
  }

  require(key: string, version: number): RuntimeHandler<unknown> {
    const handler = this.get(key, version);
    if (!handler) {
      throw Object.assign(new Error(`Runtime handler version unavailable: ${key}@${version}`), {
        code: "handler_version_unavailable",
      });
    }
    return handler;
  }

  list(): Array<Pick<RuntimeHandler<unknown>, "key" | "version" | "inputSchemaVersion" | "resourcePool" | "executorProfile" | "requiredCapabilities">> {
    return [...this.handlers.values()]
      .map(({ key, version, inputSchemaVersion, resourcePool, executorProfile, requiredCapabilities }) => ({
        key,
        version,
        inputSchemaVersion,
        resourcePool,
        executorProfile,
        requiredCapabilities: [...requiredCapabilities],
      }))
      .sort((left, right) => left.key.localeCompare(right.key) || left.version - right.version);
  }
}

export const runtimeHandlerRegistry = new RuntimeHandlerRegistry();
