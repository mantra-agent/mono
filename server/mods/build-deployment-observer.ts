import { and, asc, eq } from "drizzle-orm";
import {
  environmentHostingBindings,
  platformProductEnvironments,
  platformProducts,
  platforms,
  providerConnections,
} from "@shared/models/platforms";
import { modInstallations, users } from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import {
  createNamedSystemPrincipal,
  createUserSessionPrincipal,
  type Principal,
} from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithVisibleScope, type ScopeColumns } from "../scoped-storage";
import { extractDeploymentMeta } from "../integrations/railway/client";
import {
  fetchEnvironmentDeployments,
  resolveRailwayEnvironmentControl,
} from "../integrations/railway/environment-control";
import { hasActiveBuildAccess } from "./build-access";
import {
  recordSuccessfulRailwayDeployments,
  type BuildDeploymentEnvironmentIdentity,
} from "./build-deployment-home";
import { invalidateSimpleFeedCache } from "../simple/generate-feed";

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

interface VisibleRailwayEnvironment extends BuildDeploymentEnvironmentIdentity {
  connectionId: number;
}

let observerRunning = false;
let observerStarted = false;

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
  return db
    .select({
      platformEnvironmentId: platformProductEnvironments.id,
      environmentName: platformProductEnvironments.name,
      productName: platformProducts.name,
      platformName: platforms.name,
      connectionId: providerConnections.id,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProducts.id, platformProductEnvironments.productId))
    .innerJoin(platforms, eq(platforms.id, platformProducts.platformId))
    .innerJoin(
      environmentHostingBindings,
      eq(environmentHostingBindings.environmentId, platformProductEnvironments.id),
    )
    .innerJoin(providerConnections, eq(providerConnections.id, environmentHostingBindings.connectionId))
    .where(and(
      combineWithVisibleScope(principal, platformScope),
      combineWithVisibleScope(principal, providerScope),
      eq(platforms.status, "active"),
      eq(platformProducts.status, "active"),
      eq(providerConnections.status, "active"),
      eq(environmentHostingBindings.provider, "railway"),
      eq(providerConnections.provider, "railway"),
    ))
    .orderBy(asc(platformProductEnvironments.id))
    .limit(ENVIRONMENT_LIMIT);
}

async function observeEnvironment(
  principal: Principal,
  environment: VisibleRailwayEnvironment,
): Promise<{ observationsCreated: number; projectionsCreated: number }> {
  if (!(await hasActiveBuildAccess(principal))) return { observationsCreated: 0, projectionsCreated: 0 };

  const control = await resolveRailwayEnvironmentControl(environment.platformEnvironmentId);
  if (control.environment.connectionId !== environment.connectionId) {
    throw new Error("Railway environment binding changed during observation");
  }

  const deployments = await fetchEnvironmentDeployments(control, DEPLOYMENT_LIMIT);
  const successful = deployments.flatMap((deployment) => {
    if (deployment.status !== "SUCCESS") return [];
    const deployedAtValue = deployment.updatedAt ?? deployment.createdAt;
    const deployedAt = deployedAtValue ? new Date(deployedAtValue) : null;
    if (!deployment.id?.trim() || !deployedAt || Number.isNaN(deployedAt.getTime())) return [];
    const meta = extractDeploymentMeta(deployment.meta);
    return [{
      providerDeploymentId: deployment.id,
      deployedAt,
      commitSha: meta.commitHash ?? null,
    }];
  });

  return recordSuccessfulRailwayDeployments(principal, environment, successful);
}

type DiscoveredBuildOwner = Awaited<ReturnType<typeof discoverActiveBuildOwners>>[number];

async function observeOwner(user: DiscoveredBuildOwner["user"]) {
  const principal = await createUserSessionPrincipal(user);
  return runWithPrincipal(principal, async () => {
    if (!(await hasActiveBuildAccess(principal))) return { observationsCreated: 0, projectionsCreated: 0, errors: 0 };
    const environments = await listVisibleRailwayEnvironments(principal);
    let observationsCreated = 0;
    let projectionsCreated = 0;
    let errors = 0;

    for (const environment of environments) {
      try {
        const result = await observeEnvironment(principal, environment);
        observationsCreated += result.observationsCreated;
        projectionsCreated += result.projectionsCreated;
      } catch (error) {
        errors += 1;
        log.warn("Railway deployment observation degraded", {
          platformEnvironmentId: environment.platformEnvironmentId,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    if (projectionsCreated > 0) invalidateSimpleFeedCache(principal.accountId ?? undefined);
    return { observationsCreated, projectionsCreated, errors };
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
          errorName: error instanceof Error ? error.name : typeof error,
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
      errorName: error instanceof Error ? error.name : typeof error,
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
