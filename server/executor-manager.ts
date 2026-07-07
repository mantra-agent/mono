// Use createLogger for logging ONLY
import { readFile, writeFile, mkdir } from "fs/promises";
import type { GatewayStatus } from "@shared/schema";
import { WORKSPACE_DIR, SESSIONS_DIR } from "./paths";
import { agentExecutor } from "./agent-executor";
import { eventBus } from "./event-bus";
import { join, resolve } from "path";
import { getSetting, setSetting } from "./system-settings";
import { pathExists, resolveWorkspacePath as resolveWsPath } from "./fs-utils";
import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";

const logger = createLogger("ExecutorManager");

type LogCallback = (log: { level: string; message: string; source: string }) => void;

class ExecutorManager {
  private logCallbacks: Set<LogCallback> = new Set();
  private manuallyStopped = false;
  private supervisorTimer: NodeJS.Timeout | null = null;
  private supervisorRunning = false;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private startTime: number | null = null;
  private _running = false;
  private startInProgress = false;
  private restartingInProgress = false;

  private static VERSION = "0.18.0";

  get isRunning(): boolean {
    return this._running;
  }

  onLog(callback: LogCallback) {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  private emitLog(level: string, message: string, source = "agent") {
    const log = { level, message, source, bootId: eventBus.bootId };
    this.logCallbacks.forEach((cb) => cb(log));
    const emitLogger = createLogger(source);
    if (level === "error") emitLogger.error(message);
    else if (level === "warn") emitLogger.warn(message);
    else if (level === "debug") emitLogger.debug(message);
    else emitLogger.log(message);
  }

  private hasApiKeys(): boolean {
    return !!(
      getSecretSync("ANTHROPIC_API_KEY") ||
      getSecretSync("OPENAI_API_KEY")
    );
  }

  async getStatus(): Promise<GatewayStatus> {
    if (this._running) {
      const activeRuns = agentExecutor.getActiveRunCount();
      const chatActiveRuns = agentExecutor.getChatActiveRunCount();
      return {
        status: "running",
        pid: process.pid,
        port: parseInt(process.env.PORT || "5000", 10),
        uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : undefined,
        version: ExecutorManager.VERSION,
        activeRuns,
        chatActiveRuns,
      };
    }

    const supervisorGaveUp = !this.manuallyStopped && this.restartAttempts > this.maxRestartAttempts;
    const isRestarting = this.restartingInProgress;

    return {
      status: supervisorGaveUp ? "error" as const : isRestarting ? "restarting" as const : "stopped" as const,
      version: ExecutorManager.VERSION,
      manuallyStopped: this.manuallyStopped,
      error: supervisorGaveUp ? "Agent crashed repeatedly. Use Start to try again." : undefined,
    };
  }

  getSetupStatus(): { configured: boolean; hasModelConfig: boolean } {
    const hasModelConfig = this.hasApiKeys();

    return {
      configured: hasModelConfig,
      hasModelConfig,
    };
  }

  async readConfig(): Promise<Record<string, any>> {
    try {
      const config = await getSetting<Record<string, any>>("agent_config");
      this.emitLog("debug", `Config read: ${Object.keys(config || {}).length} keys`, "executor-manager");
      return config || {};
    } catch (err: any) {
      this.emitLog("warn", `Config read failed: ${err.message}`, "executor-manager");
      return {};
    }
  }

  async resetConfig(): Promise<void> {
    try {
      await setSetting("agent_config", {});
      this.emitLog("info", "Config reset to empty", "executor-manager");
    } catch (err: any) {
      this.emitLog("error", `Config reset failed: ${err.message}`, "executor-manager");
    }
  }

  async writeConfig(config: Record<string, any>): Promise<void> {
    try {
      const existing = await this.readConfig();
      const merged = deepMerge(existing, config);
      await setSetting("agent_config", merged);
      this.emitLog("info", `Config written: ${Object.keys(config).join(",")}`, "executor-manager");
    } catch (err: any) {
      this.emitLog("error", `Config write failed: ${err.message}`, "executor-manager");
      throw new Error(`Failed to write config: ${err.message}`);
    }
  }

  async ensureDirectoriesAsync(): Promise<void> {
    await mkdir(WORKSPACE_DIR, { recursive: true });
    await mkdir(SESSIONS_DIR, { recursive: true });
  }

  private resolveWorkspacePath(filename: string): string {
    const resolved = resolveWsPath(filename);
    if (!resolved) throw new Error("Invalid file path");
    return resolved;
  }

  async writeWorkspaceFile(filename: string, content: string): Promise<void> {
    const filePath = this.resolveWorkspacePath(filename);
    const dir = join(filePath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, "utf-8");
    this.emitLog("debug", `Workspace file written: ${filename} (${content.length} bytes)`, "executor-manager");
  }

  async readWorkspaceFile(filename: string): Promise<string | null> {
    const filePath = this.resolveWorkspacePath(filename);
    try {
      if (await pathExists(filePath)) {
        const content = await readFile(filePath, "utf-8");
        this.emitLog("debug", `Workspace file read: ${filename} (${content.length} bytes)`, "executor-manager");
        return content;
      }
    } catch (err: any) {
      this.emitLog("error", `Workspace file read failed: ${filename} error=${err.message}`, "executor-manager");
    }
    return null;
  }

  async start(): Promise<string> {
    if (this.startInProgress) {
      this.emitLog("debug", "Agent start skipped — already in progress", "executor-manager");
      return "Agent start already in progress";
    }

    if (this._running) {
      this.emitLog("debug", "Agent start skipped — already running", "executor-manager");
      return "Agent is already running";
    }

    this.startInProgress = true;
    this.manuallyStopped = false;
    this.emitLog("info", "Agent start initiated...", "executor-manager");

    try {
      if (!this.hasApiKeys()) {
        this.emitLog("warn", "No LLM API keys found. Agent will start but cannot process messages until keys are configured.", "agent");
      }

      await this.ensureDirectoriesAsync();

      this.startTime = Date.now();
      this._running = true;

      this.emitLog("info", `Agent executor started (v${ExecutorManager.VERSION})`, "agent");

      eventBus.publish({
        category: "agent",
        event: "agent.started",
        payload: { version: ExecutorManager.VERSION },
        sessionKey: "system",
      });

      this.restartAttempts = 0;
      return `Agent executor started (v${ExecutorManager.VERSION})`;
    } catch (err: any) {
      this.emitLog("error", `Agent start failed: ${err.message}`, "agent");
      throw err;
    } finally {
      this.startInProgress = false;
    }
  }

  async stop(): Promise<string> {
    this.startInProgress = false;

    if (!this._running) {
      this.manuallyStopped = true;
      this.emitLog("debug", "Agent stop called but not running", "executor-manager");
      return "Agent is not running";
    }

    this.manuallyStopped = true;
    const activeRuns = agentExecutor.getActiveRunCount();
    this.emitLog("info", `Stopping agent executor... activeRuns=${activeRuns}`, "executor-manager");

    agentExecutor.abortAll();

    this._running = false;
    const uptimeSec = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    this.startTime = null;

    eventBus.publish({
      category: "agent",
      event: "agent.stopped",
      payload: {},
      sessionKey: "system",
    });

    this.emitLog("info", `Agent executor stopped uptime=${uptimeSec}s abortedRuns=${activeRuns}`, "executor-manager");
    return "Agent stopped";
  }

  async restart(): Promise<string> {
    this.emitLog("info", "Agent restart requested", "executor-manager");
    this.startInProgress = false;
    this.manuallyStopped = true;
    await this.stop();
    this.manuallyStopped = false;
    this.restartAttempts = 0;
    return this.start();
  }

  private supervisorHealthCheck() {
    if (this.manuallyStopped || this.restartingInProgress || this.startInProgress) {
      this.emitLog("debug", `Supervisor health check skipped manuallyStopped=${this.manuallyStopped} restartingInProgress=${this.restartingInProgress} startInProgress=${this.startInProgress}`, "supervisor");
      return;
    }

    if (this._running) {
      if (this.startTime && (Date.now() - this.startTime) > 30000) {
        this.restartAttempts = 0;
      }
      const activeRuns = agentExecutor.getActiveRunCount();
      this.emitLog("debug", `Supervisor health check: running=true activeRuns=${activeRuns} uptime=${this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0}s`, "supervisor");
      return;
    }

    if (this.restartAttempts > 0) {
      this.emitLog("debug", `Supervisor health check: waiting, restartAttempts=${this.restartAttempts}`, "supervisor");
      return;
    }

    if (!this._running && this.hasApiKeys()) {
      this.emitLog("info", "Supervisor detected agent is not running. Starting...", "supervisor");
      this.start().catch((err) => {
        this.emitLog("error", `Supervisor auto-start failed: ${err.message}`, "supervisor");
      });
    }
  }

  startSupervisor() {
    if (this.supervisorRunning) {
      this.emitLog("debug", "Supervisor already running, skipping start", "supervisor");
      return;
    }
    this.supervisorRunning = true;

    this.emitLog("info", "Agent supervisor started", "supervisor");

    setTimeout(() => {
      if (!this.manuallyStopped) {
        this.supervisorHealthCheck();
      }
    }, 3000);

    this.supervisorTimer = setInterval(() => {
      this.supervisorHealthCheck();
    }, 20000);
  }

  stopSupervisor() {
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = null;
    }
    this.supervisorRunning = false;
    this.emitLog("info", "Agent supervisor stopped", "supervisor");
  }
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export const executorManager = new ExecutorManager();
