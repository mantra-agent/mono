import { and, asc, eq } from "drizzle-orm";
import {
  environmentHostingBindings,
  platformProductEnvironments,
  products,
  platforms,
  providerConnections,
} from "@shared/models/platforms";
import { modInstallations, users } from "@shared/schema";
import { db } from "../db";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";
import {
  createNamedSystemPrincipal,
  createUserSessionPrincipal,
  type Principal,
} from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithVisibleScope, type ScopeColumns } from "../scoped-storage";
import { extractDeploymentMeta } from "../integrations/railway/client";
import { runWithRailwayAttribution } from "../integrations/railway/request-attribution";
import {
  fetchEnvironmentDeploymentSnapshot,
  resolveRailwayEnvironmentControl,
} from "../integrations/railway/environment-control";
import { hasActiveModAccess } from "./mod-access";
const hasActiveBuildAccess = (principal: Principal) => hasActiveModAccess(principal, "build");
import {
  recordSuccessfulRailwayDeployments,
  type BuildDeploymentEnvironmentIdentity,
} from "./build-deployment-home";
const log = createLogger("build-deployment-observer");
const OBSERVER_PRINCIPAL = createNamedSystemPrincipal("build-deployment-observer");
const OWNER_LIMIT = 50;
const ENVIRONMENT_LIMIT = 50;
const DEPLOYMENT_LIMIT = 20;
const FIRST_RUN_DELAY_MS = 45_000;
const POLL_INTERVAL_MS = 5 * 60_000;

const platformScope: ScopeColumns = {
  scope: platforms.scope,
  ownerUserId: platforms.ownerUserId,
  accountId: platforms.accountId,
};
const providerScope: ScopeColumns = {
  scope: providerConnections.scope,
  ownerUserId: providerConnections.ownerUserId,
  accountId: providerConnections.accountId,
};

type VisibleRailwayEnvironment = BuildDeploymentEnvironmentIdentity;

let observerRunning = false;
let observerStarted = false;

function serializeObservationError(error: unknown): {
  errorName: string;
  errorMessage: string | null;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, 500),
    };
  }
  return {
    errorName: typeof error,
    errorMessage: typeof error === "string" ? error.slice(0, 500) : null,
  };
}

async function discoverActiveBuildOwners() {
  return runWithPrincipal(OBSERVER_PRINCIPAL, () => db
    .selectDistinct({ user: users })
    .from(modInstallations)
    .innerJoin(users, eq(users.id, modInstallations.ownerUserId))
    .where(and(
      eq(modInstallations.modKey, "build"),
      eq(modInstallations.status, "active"),
    ))
    .orderBy(asc(users.id))
    .limit(OWNER_LIMIT));
}

async function listVisibleRailwayEnvironments(principal: Principal): Promise<VisibleRailwayEnvironment[]> {
  // Discovery only. resolveRailwayEnvironmentControl owns the canonical hosting
  // binding; joining every binding row here used to emit duplicate environments
  // and a false "binding changed" hard-fail when join order disagreed.
  const rows = await db
    .select({
      platformEnvironmentId: platformProductEnvironments.id,
      environmentName: platformProductEnvironments.name,
      productName: products.name,
      platformName: platforms.name,
      hostingBindingId: environmentHostingBindings.id,
    })
    .from(platformProductEnvironments)
    .innerJoin(products, eq(products.id, platformProductEnvironments.productId))
    .innerJoin(platforms, eq(platforms.id, platformProductEnvironments.platformId))
    .innerJoin(
      environmentHostingBindings,
      eq(environmentHostingBindings.environmentId, platformProductEnvironments.id),
    )
    .innerJoin(providerConnections, eq(providerConnections.id, environmentHostingBindings.connectionId))
    .where(and(
      combineWithVisibleScope(principal, platformScope),
      combineWithVisibleScope(principal, providerScope),
      eq(platforms.status, "active"),
      eq(products.status, "active"),
      eq(providerConnections.status, "active"),
      eq(environmentHostingBindings.provider, "railway"),
      eq(providerConnections.provider, "railway"),
    ))
    .orderBy(asc(platformProductEnvironments.id), asc(environmentHostingBindings.id))
    .limit(ENVIRONMENT_LIMIT);

  const deduped = new Map<number, VisibleRailwayEnvironment>();
  for (const row of rows) {
    if (deduped.has(row.platformEnvironmentId)) continue;
    deduped.set(row.platformEnvironmentId, {
      platformEnvironmentId: row.platformEnvironmentId,
      environmentName: row.environmentName,
      productName: row.productName,
      platformName: row.platformName,
    });
  }
  return Array.from(deduped.values());
}

async function observeEnvironment(
  principal: Principal,
  environment: VisibleRailwayEnvironment,
): Promise<{
  observationsCreated: number;
  projectionsCreated: number;
  completions: Awaited<ReturnType<typeof recordSuccessfulRailwayDeployments>>["completions"];
}> {
  if (!(await hasActiveBuildAccess(principal))) {
    return { observationsCreated: 0, projectionsCreated: 0, completions: [] };
  }

  // Canonical Railway binding + credential come from the shared resolver, not
  // the discovery join. That keeps observer I/O aligned with platforms status.
  const control = await resolveRailwayEnvironmentControl(environment.platformEnvironmentId);
  const snapshot = await runWithRailwayAttribution({ caller: "build_deployment_observer" }, () =>
    fetchEnvironmentDeploymentSnapshot(control, DEPLOYMENT_LIMIT, { refresh: "observer" }));
  const successful = snapshot.deployments.flatMap((deployment) => {
    if (deployment.status !== "SUCCESS") return [];
    const deployedAtValue = deployment.updatedAt ?? deployment.createdAt;
    const deployedAt = deployedAtValue ? new Date(deployedAtValue) : null;
    const startedAt = deployment.createdAt ? new Date(deployment.createdAt) : null;
    if (!deployment.id?.trim() || !deployedAt || Number.isNaN(deployedAt.getTime())) return [];
    const validStartedAt = startedAt && !Number.isNaN(startedAt.getTime()) && startedAt <= deployedAt
      ? startedAt
      : null;
    const meta = extractDeploymentMeta(deployment.meta);
    const commitSha = meta.commitHash?.trim() || null;
    return [{
      providerDeploymentId: deployment.id.trim(),
      deployedAt,
      startedAt: validStartedAt,
      durationMs: validStartedAt ? deployedAt.getTime() - validStartedAt.getTime() : null,
      commitSha,
    }];
  });

  return recordSuccessfulRailwayDeployments(principal, environment, successful);
}

type DiscoveredBuildOwner = Awaited<ReturnType<typeof discoverActiveBuildOwners>>[number];

async function observeOwner(user: DiscoveredBuildOwner["user"]) {
  const principal = await createUserSessionPrincipal(user);
  return runWithPrincipal(principal, async () => {
    if (!(await hasActiveBuildAccess(principal))) {
      return { observationsCreated: 0, projectionsCreated: 0, completions: [], errors: 0 };
    }
    const environments = await listVisibleRailwayEnvironments(principal);
    let observationsCreated = 0;
    let projectionsCreated = 0;
    const completions: Awaited<ReturnType<typeof recordSuccessfulRailwayDeployments>>["completions"] = [];
    let errors = 0;

    for (const environment of environments) {
      try {
        const result = await observeEnvironment(principal, environment);
        observationsCreated += result.observationsCreated;
        projectionsCreated += result.projectionsCreated;
        completions.push(...result.completions);
      } catch (error) {
        errors += 1;
        log.warn("Railway deployment observation degraded", {
          platformEnvironmentId: environment.platformEnvironmentId,
          ...serializeObservationError(error),
        });
      }
    }

    if (projectionsCreated > 0) {
      eventBus.publish({
        category: "system",
        event: "data:home_changed",
        payload: {
          source: "build_deployment_observer",
          projectionsCreated,
          buildCompletions: completions.map(completion => ({
            ...completion,
            deployedAt: completion.deployedAt.toISOString(),
          })),
        },
      }, principal);
    }
    return { observationsCreated, projectionsCreated, completions, errors };
  });
}

/** One bounded cross-account observation sweep. Database uniqueness owns replay safety. */
export async function runBuildDeploymentObservationSweep(): Promise<void> {
  if (observerRunning) {
    log.debug("Build deployment observation sweep skipped: previous sweep still running");
    return;
  }
  observerRunning = true;
  const startedAt = Date.now();
  try {
    const owners = await discoverActiveBuildOwners();
    let observationsCreated = 0;
    let projectionsCreated = 0;
    let errors = 0;
    for (const { user } of owners) {
      try {
        const result = await observeOwner(user);
        observationsCreated += result.observationsCreated;
        projectionsCreated += result.projectionsCreated;
        errors += result.errors;
      } catch (error) {
        errors += 1;
        log.warn("Build deployment owner observation degraded", {
          userId: user.id,
          ...serializeObservationError(error),
        });
      }
    }
    log.info("Build deployment observation sweep completed", {
      owners: owners.length,
      observationsCreated,
      projectionsCreated,
      errors,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    log.error("Build deployment observation sweep failed", {
      ...serializeObservationError(error),
      durationMs: Date.now() - startedAt,
    });
  } finally {
    observerRunning = false;
  }
}

export function startBuildDeploymentObserver(): void {
  if (observerStarted) return;
  observerStarted = true;
  setTimeout(() => void runBuildDeploymentObservationSweep(), FIRST_RUN_DELAY_MS).unref();
  setInterval(() => void runBuildDeploymentObservationSweep(), POLL_INTERVAL_MS).unref();
  log.info("Build deployment observer registered", {
    firstRunDelayMs: FIRST_RUN_DELAY_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    ownerLimit: OWNER_LIMIT,
    environmentLimit: ENVIRONMENT_LIMIT,
    deploymentLimit: DEPLOYMENT_LIMIT,
  });
}
