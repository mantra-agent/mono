import fs from "fs/promises";
import path from "path";
import type { Locator, Page } from "playwright-core";
import { issueRegressionContractInputSchema, type RegressionScenarioStep } from "@shared/models/regression";
import { getCurrentPrincipal } from "../principal-context";
import { ObjectStorageService } from "../object_storage";
import { resolvePlatformBindingSessionSecret } from "../platforms/platform-binding-browser-auth";
import { appendRegressionResult, getRegressionIssue } from "./regression-service";

const SCENARIO_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 7_000;
const MAX_EVIDENCE_TEXT = 500;
const MAX_CONSOLE_EVENTS = 25;

function truncate(value: unknown, max = MAX_EVIDENCE_TEXT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function lifecycleConfig(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") return {};
  const config = (snapshot as Record<string, unknown>).config;
  return config && typeof config === "object" ? config as Record<string, unknown> : {};
}
function acceptanceTarget(snapshot: unknown): Record<string, unknown> {
  const config = lifecycleConfig(snapshot);
  const acceptance = config.acceptance && typeof config.acceptance === "object" ? config.acceptance as Record<string, unknown> : {};
  const target = acceptance.target && typeof acceptance.target === "object" ? acceptance.target : config.acceptanceTarget;
  return target && typeof target === "object" ? target as Record<string, unknown> : {};
}
function authMode(snapshot: unknown): string {
  const config = lifecycleConfig(snapshot);
  const acceptance = config.acceptance && typeof config.acceptance === "object" ? config.acceptance as Record<string, unknown> : {};
  const value = acceptance.authMode ?? config.authMode;
  return typeof value === "string" && value.trim() ? value.trim() : "none";
}
function targetUrl(snapshot: unknown): string {
  const target = acceptanceTarget(snapshot);
  const hosting = snapshot && typeof snapshot === "object" && (snapshot as Record<string, unknown>).hosting && typeof (snapshot as Record<string, unknown>).hosting === "object"
    ? (snapshot as Record<string, unknown>).hosting as Record<string, unknown>
    : {};
  const raw = typeof target.url === "string" && target.url.trim()
    ? target.url.trim()
    : typeof hosting.publicUrl === "string" ? hosting.publicUrl.trim() : "";
  if (!raw) throw new Error("Regression target invariant failed: lifecycle snapshot has no acceptance URL");
  const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Regression target invariant failed: acceptance URL must be credential-free HTTP(S)");
  return parsed.origin;
}
function joinTargetPath(origin: string, routePath: string): string {
  const url = new URL(origin);
  const parsed = new URL(routePath, origin);
  if (parsed.origin !== origin || !routePath.startsWith("/") || routePath.startsWith("//")) throw new Error("Regression route escaped the snapshotted acceptance target");
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  url.hash = parsed.hash;
  return url.toString();
}

type ScenarioTarget = Extract<RegressionScenarioStep, { action: "click" | "fill" | "assert_element" }>["target"];

function locatorFor(page: Page, target: ScenarioTarget): Locator {
  switch (target.by) {
    case "role": return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true });
    case "test_id": return page.getByTestId(target.value);
    case "label": return page.getByLabel(target.value, { exact: true });
    case "placeholder": return page.getByPlaceholder(target.value, { exact: true });
  }
}

async function waitForUrlPath(page: Page, origin: string, expectedPath: string): Promise<void> {
  await page.waitForURL((value) => value.origin === origin && `${value.pathname}${value.search}${value.hash}` === expectedPath, { timeout: ACTION_TIMEOUT_MS });
}

async function executeStep(page: Page, origin: string, step: RegressionScenarioStep): Promise<{ assertion?: Record<string, unknown> }> {
  switch (step.action) {
    case "navigate":
      await page.goto(joinTargetPath(origin, step.path), { waitUntil: "domcontentloaded", timeout: 15_000 });
      return {};
    case "click":
      await locatorFor(page, step.target).click({ timeout: ACTION_TIMEOUT_MS });
      return {};
    case "fill":
      await locatorFor(page, step.target).fill(step.value, { timeout: ACTION_TIMEOUT_MS });
      return {};
    case "press":
      if (step.target) await locatorFor(page, step.target).press(step.key, { timeout: ACTION_TIMEOUT_MS });
      else await page.keyboard.press(step.key);
      return {};
    case "wait_for":
      if (step.state.kind === "text") await page.getByText(step.state.text, { exact: true }).waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      else if (step.state.kind === "element") await locatorFor(page, step.state.target).waitFor({ state: step.state.visible ? "visible" : "hidden", timeout: ACTION_TIMEOUT_MS });
      else await waitForUrlPath(page, origin, step.state.path);
      return {};
    case "assert_text": {
      const visible = await page.getByText(step.text, { exact: true }).isVisible({ timeout: ACTION_TIMEOUT_MS });
      if (visible !== step.visible) throw new Error(`Expected text visibility ${step.visible}, observed ${visible}`);
      return { assertion: { kind: "text", expectedVisible: step.visible, passed: true } };
    }
    case "assert_element": {
      const visible = await locatorFor(page, step.target).isVisible({ timeout: ACTION_TIMEOUT_MS });
      if (visible !== step.visible) throw new Error(`Expected element visibility ${step.visible}, observed ${visible}`);
      return { assertion: { kind: "element", expectedVisible: step.visible, passed: true } };
    }
    case "assert_url": {
      const current = new URL(page.url());
      const actualPath = `${current.pathname}${current.search}${current.hash}`;
      if (current.origin !== origin || actualPath !== step.path) throw new Error(`Expected URL path ${step.path}, observed ${actualPath}`);
      return { assertion: { kind: "url", expectedPath: step.path, passed: true } };
    }
  }
}

async function persistScreenshot(filePath: string, width: number, height: number, truncated: boolean) {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) throw new Error("Regression screenshot persistence requires an explicit user principal");
  const body = await fs.readFile(filePath);
  const service = new ObjectStorageService();
  const uploaded = await service.uploadObjectEntity(body, {
    extension: ".png",
    contentType: "image/png",
    category: "regression",
    principal,
    acl: {
      owner: principal.userId,
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      createdByUserId: principal.userId,
      scope: "user",
      visibility: "private",
    },
  });
  await fs.unlink(filePath).catch(() => undefined);
  return { path: uploaded.objectPath, width, height, truncated };
}

async function captureScenarioScreenshot(page: Page) {
  const scratchDir = process.env.SCRATCH_DIR || "/app/scratch";
  const directory = path.join(scratchDir, "screenshots");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => viewport.height);
  const truncated = scrollHeight > 4_000;
  if (truncated) await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: viewport.width, height: 4_000 } });
  else await page.screenshot({ path: filePath, fullPage: true });
  return persistScreenshot(filePath, viewport.width, truncated ? 4_000 : scrollHeight, truncated);
}

export async function executeRegressionScenario(input: { runId: string; issueId: number; planStepId?: string; sessionId?: string }) {
  const context = await getRegressionIssue(input.runId, input.issueId);
  if (context.latestResult) return context.latestResult;
  if (context.exclusion) throw new Error(`Issue ${input.issueId} is excluded from run ${input.runId}: ${context.exclusion.reasonCode}`);
  if (!context.contract || !context.contractValid || context.contract.disposition !== "enabled") {
    return appendRegressionResult({
      runId: input.runId,
      issueId: input.issueId,
      status: "blocked",
      reasonCode: !context.contract ? "missing_contract" : "invalid_contract",
      summary: !context.contract ? "Issue has no regression contract." : "Issue regression contract is invalid or unsupported.",
      planStepId: input.planStepId,
      sessionId: input.sessionId,
      contractVersion: context.contract?.version,
      browserEvidence: { executionAttempted: false },
    });
  }

  const parsedContract = issueRegressionContractInputSchema.parse({
    disposition: context.contract.disposition,
    exclusionReason: context.contract.exclusionReason,
    environmentIds: context.contract.environmentIds,
    routePath: context.contract.routePath,
    steps: context.contract.steps,
    expectedOutcome: context.contract.expectedOutcome,
    setupNotes: context.contract.setupNotes,
  });
  const origin = targetUrl(context.run.lifecycleSnapshot);
  const entryUrl = joinTargetPath(origin, parsedContract.routePath!);
  const mode = authMode(context.run.lifecycleSnapshot);
  const principal = getCurrentPrincipal();
  if (!principal?.userId || principal.userId !== context.run.ownerUserId) throw new Error("Regression run owner principal is not active");
  const authentication = mode === "none"
    ? { mode: "none" as const }
    : mode === "platform_binding"
      ? { mode: "platform_binding" as const, userId: context.run.ownerUserId, sessionSecret: await resolvePlatformBindingSessionSecret(context.run.lifecycleSnapshot) }
      : null;
  if (!authentication) {
    return appendRegressionResult({ runId: input.runId, issueId: input.issueId, status: "blocked", reasonCode: "unsupported_auth_mode", summary: `Regression auth mode ${mode} is unsupported.`, planStepId: input.planStepId, sessionId: input.sessionId, contractVersion: context.contract.version, browserEvidence: { executionAttempted: false, authMode: mode } });
  }

  const actionTrace: Array<Record<string, unknown>> = [];
  const assertions: Array<Record<string, unknown>> = [];
  const consoleEvidence: Array<Record<string, unknown>> = [];
  let screenshot: Awaited<ReturnType<typeof captureScenarioScreenshot>> | null = null;
  try {
    const { withTargetBoundBrowserPage } = await import("../browser-manager");
    const execution = await withTargetBoundBrowserPage(entryUrl, { viewport: "desktop", timeoutMs: SCENARIO_TIMEOUT_MS, authentication }, async (page) => {
        page.on("console", (message) => {
          if (consoleEvidence.length < MAX_CONSOLE_EVENTS && ["error", "warning"].includes(message.type())) consoleEvidence.push({ kind: "console", level: message.type(), text: truncate(message.text()) });
        });
        page.on("pageerror", (error) => {
          if (consoleEvidence.length < MAX_CONSOLE_EVENTS) consoleEvidence.push({ kind: "pageerror", text: truncate(error.message) });
        });
        for (let index = 0; index < parsedContract.steps.length; index += 1) {
          const step = parsedContract.steps[index];
          const startedAt = Date.now();
          try {
            const outcome = await executeStep(page, origin, step);
            actionTrace.push({ index, action: step.action, status: "passed", durationMs: Date.now() - startedAt, urlPath: new URL(page.url()).pathname });
            if (outcome.assertion) assertions.push({ index, ...outcome.assertion });
          } catch (error) {
            actionTrace.push({ index, action: step.action, status: "failed", durationMs: Date.now() - startedAt, error: truncate(error instanceof Error ? error.message : String(error)) });
            throw error;
          }
        }
        screenshot = await captureScenarioScreenshot(page);
        return { completed: true };
      });
    return appendRegressionResult({
      runId: input.runId,
      issueId: input.issueId,
      status: "passed",
      reasonCode: "scenario_passed",
      summary: parsedContract.expectedOutcome || "Regression scenario passed.",
      planStepId: input.planStepId,
      sessionId: input.sessionId,
      contractVersion: context.contract.version,
      actionTrace,
      assertions,
      screenshots: screenshot ? [screenshot] : [],
      browserEvidence: { ...execution.evidence, authMode: mode, console: consoleEvidence },
    });
  } catch (error) {
    const summary = truncate(error instanceof Error ? error.message : String(error), 2_000);
    return appendRegressionResult({
      runId: input.runId,
      issueId: input.issueId,
      status: "failed",
      reasonCode: summary.includes("exceeded") ? "scenario_timeout" : "scenario_failed",
      summary,
      planStepId: input.planStepId,
      sessionId: input.sessionId,
      contractVersion: context.contract.version,
      actionTrace,
      assertions,
      screenshots: screenshot ? [screenshot] : [],
      browserEvidence: { targetOrigin: origin, authMode: mode, console: consoleEvidence },
    });
  }
}
