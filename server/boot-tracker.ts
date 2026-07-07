import type { Express } from "express";
import { createLogger } from "./log";
import { getAnalyzeProgress } from "./gitnexus-bridge";

const log = createLogger("boot-tracker");

// `degraded` = phase finished without success but the system can still serve
// (used by code_intelligence on timeout: gitnexus indexing takes longer than
// the boot ceiling, but we don't want to fail the whole boot). The boot gate
// renders this as a non-blocking warning rather than a hard error.
export type PhaseStatus = "pending" | "active" | "done" | "error" | "degraded";

export interface AnalyzeProgress {
  percent: number;
  label?: string;
}

export interface BootPhaseInfo {
  name: string;
  label: string;
  status: PhaseStatus;
  durationMs: number | null;
  error?: string;
  analyzeProgress?: AnalyzeProgress;
}

interface InternalPhase extends BootPhaseInfo {
  _startedAt?: number;
}

const PHASES: { name: string; label: string }[] = [
  { name: "database", label: "Database" },
  { name: "skills_library", label: "Skills & Library" },
  { name: "memory", label: "Memory" },
  { name: "routes_auth", label: "Routes & Auth" },
  { name: "server", label: "Server" },
  { name: "code_intelligence", label: "Code Intelligence" },
  { name: "background_services", label: "Background Services" },
];

export class BootTracker {
  private phases: Map<string, InternalPhase> = new Map();
  private ready = false;
  private bootError: string | null = null;
  private startedAt = Date.now();

  constructor() {
    for (const p of PHASES) {
      this.phases.set(p.name, {
        name: p.name,
        label: p.label,
        status: "pending",
        durationMs: null,
      });
    }
  }

  startPhase(name: string): void {
    const phase = this.phases.get(name);
    if (!phase) return;
    phase.status = "active";
    phase._startedAt = Date.now();
    log.log(`phase=${name} status=active`);
    this.publishEvent(name, "active");
  }

  completePhase(name: string): void {
    const phase = this.phases.get(name);
    if (!phase) return;
    const startedAt = phase._startedAt || Date.now();
    phase.status = "done";
    phase.durationMs = Date.now() - startedAt;
    log.log(`phase=${name} status=done duration=${phase.durationMs}ms`);
    this.publishEvent(name, "done");
  }

  failPhase(name: string, error: string): void {
    const phase = this.phases.get(name);
    if (!phase) return;
    const startedAt = phase._startedAt || Date.now();
    phase.status = "error";
    phase.durationMs = Date.now() - startedAt;
    phase.error = error;
    log.log(`phase=${name} status=error error=${error}`);
    this.publishEvent(name, "error");
  }

  // Neither success nor hard failure — used when a phase exceeds its boot
  // ceiling but the rest of the system can still serve (e.g. gitnexus
  // analyze is still running but we don't want to block the app forever).
  markPhaseDegraded(name: string, error: string): void {
    const phase = this.phases.get(name);
    if (!phase) return;
    const startedAt = phase._startedAt || Date.now();
    phase.status = "degraded";
    phase.durationMs = Date.now() - startedAt;
    phase.error = error;
    log.log(`phase=${name} status=degraded error=${error}`);
    this.publishEvent(name, "degraded");
  }

  markReady(): void {
    this.ready = true;
    log.log("boot complete");
    this.publishEvent("boot", "complete");
  }

  markBootError(error: string): void {
    this.bootError = error;
    log.log(`boot error: ${error}`);
  }

  getStatus(): { phases: BootPhaseInfo[]; ready: boolean; error: string | null; elapsedMs: number } {
    return {
      phases: Array.from(this.phases.values()).map((phase) => {
        const out: BootPhaseInfo = {
          name: phase.name,
          label: phase.label,
          status: phase.status,
          durationMs: phase.durationMs,
          ...(phase.error ? { error: phase.error } : {}),
        };
        // For code_intelligence, surface gitnexus's analyze progress so the
        // boot gate can render a slim progress bar (Task #1025). Lazy require
        // to avoid an import cycle and stay quiet if the bridge is unavailable.
        if (
          phase.name === "code_intelligence" &&
          (phase.status === "active" || phase.status === "degraded")
        ) {
          // gitnexus-bridge does not import from boot-tracker, so no cycle risk.
          try {
            const progress = getAnalyzeProgress();
            if (progress) out.analyzeProgress = progress;
          } catch { /* defensive — bridge has no side-effects on call */ }
        }
        return out;
      }),
      ready: this.ready,
      error: this.bootError,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  private publishEvent(phase: string, status: string): void {
    try {
      const { eventBus } = require("./event-bus");
      eventBus.publish({
        category: "system",
        event: `system:boot_phase`,
        payload: { phase, status },
      });
      if (status === "complete") {
        eventBus.publish({
          category: "system",
          event: "system:boot_complete",
          payload: {},
        });
      }
    } catch {}
  }
}

export const bootTracker = new BootTracker();

export function registerBootStatusRoute(app: Express): void {
  app.get("/api/boot/status", (_req, res) => {
    res.json(bootTracker.getStatus());
  });
}
