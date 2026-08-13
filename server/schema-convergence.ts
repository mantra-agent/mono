import type { PgTable } from "drizzle-orm/pg-core";
import { createLogger } from "./log";
import { addObjectAclsTable } from "./migrations/add-object-acls";
import { ensureToolOutputAdmissionsTable } from "./migrations/ensure-tool-output-admissions";
import { ensureVaults } from "./migrations/ensure-vaults";
import { runSchemaBootstrap } from "./schema-bootstrap";

const log = createLogger("SchemaConvergence");

type ConvergenceReason = "boot" | "db-sync";
type ConvergencePhase = {
  name: string;
  run: () => Promise<void>;
};

async function runPhase(phase: ConvergencePhase): Promise<void> {
  const startedAt = performance.now();
  log.info("schema convergence phase started", { phase: phase.name });
  try {
    await phase.run();
    log.info("schema convergence phase completed", {
      phase: phase.name,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
  } catch (error) {
    log.error("schema convergence phase failed", error instanceof Error ? error : new Error(String(error)), {
      phase: phase.name,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
    });
    throw error;
  }
}

/**
 * The sole pre-readiness composition owner for deployed PostgreSQL schema.
 * Subsystems retain their idempotent implementation functions, but only this
 * boundary decides ordering, fatality, and observability during application boot.
 */
export async function convergeBootSchema(): Promise<void> {
  const { pool } = await import("./db");
  const phases: ConvergencePhase[] = [
    {
      name: "foundation",
      run: async () => {
        await runSchemaBootstrap("boot");
        await addObjectAclsTable();
        await ensureToolOutputAdmissionsTable();
        await ensureVaults();
      },
    },
    {
      name: "runtime-and-platform",
      run: async () => {
        const { ensureRuntimeKernelSchema } = await import("./runtime/runtime-schema");
        const { ensureLifeAddressingSchema } = await import("./life-addressing-schema");
        const { ensureModPlatformSchema } = await import("./mod-schema");
        const { ensureBuildDeploymentSchema } = await import("./build-deployment-schema");
        await ensureRuntimeKernelSchema(pool);
        await ensureLifeAddressingSchema(pool);
        await ensureModPlatformSchema(pool);
        await ensureBuildDeploymentSchema(pool);
      },
    },
    {
      name: "domain-contracts",
      run: async () => {
        const { migrateOpportunitySchema } = await import("./opportunity-storage");
        const { ensureWorkVaultParentSchema, ensureWorkVaultSchema } = await import("./work-vault-schema");
        const { ensureMilestonesSchema } = await import("./milestone-schema");
        const { ensureMetricsDefinitionsSchema } = await import("./metrics-storage");
        const { ensureBusinessPlansSchema } = await import("./business-plan-storage");
        const { ensureBusinessesSchema } = await import("./business-storage");
        const { ensureBusinessBudgetsSchema } = await import("./business-budget-schema");
        const { ensureConversationSchema } = await import("./conversation-schema");
        const { ensurePermissionSchema } = await import("./permissions");
        const { ensureMeetingAudioRetentionSchema } = await import("./meeting/audio-retention-schema");
        const { ensurePhoneSchema } = await import("./phone/schema");
        const { ensureSlackSchema } = await import("./slack/schema");
        await migrateOpportunitySchema();
        await ensureWorkVaultParentSchema(pool);
        await ensureMilestonesSchema(pool);
        await ensureBusinessesSchema();
        await ensureBusinessBudgetsSchema(pool);
        await ensureMetricsDefinitionsSchema();
        await ensureBusinessPlansSchema();
        await ensureConversationSchema(pool);
        await ensurePermissionSchema();
        await ensureMeetingAudioRetentionSchema();
        await ensurePhoneSchema(pool);
        await ensureSlackSchema(pool);
        await ensureWorkVaultSchema(pool);
      },
    },
    {
      name: "authorization-and-files",
      run: async () => {
        const { ensureProjectVaultMembershipSchema } = await import("./project-vault-access");
        const { ensurePlatformVaultMembershipSchema } = await import("./platform-vault-access");
        const { ensureObjectGrantSchema } = await import("./object-grant-schema");
        const { ensureTeamsSchema } = await import("./teams-schema");
        const { ensureOrganizationsSchema } = await import("./organizations-schema");
        const { ensureAgentInstanceSchema } = await import("./agent-instance-schema");
        const { ensureMemoryInstanceOwnershipSchema } = await import("./memory-instance-schema");
        const { ensureDriveResourcesSchema } = await import("./drive-resources-schema");
        const { ensureFilesIndexSchema } = await import("./files-index-schema");
        const { ensureDocumentArtifactsSchema } = await import("./document-artifacts-schema");
        const { ensureAgendaDefinitionSchema } = await import("./agenda-schema");
        const { ensureInvitedSubjectSchema } = await import("./invited-subject-schema");
        const { ensureTaskAssignmentSchema } = await import("./task-assignment-schema");
        await ensureProjectVaultMembershipSchema();
        await ensurePlatformVaultMembershipSchema();
        await ensureObjectGrantSchema(pool);
        await ensureTeamsSchema(pool);
        await ensureOrganizationsSchema(pool);
        // After accounts/memberships (foundation) and grant subjects; before domain consumers.
        await ensureAgentInstanceSchema(pool);
        // Phase 2 memory ownership: claims stamp/read pinned Instance after Instance exists.
        await ensureMemoryInstanceOwnershipSchema(pool);
        await ensureDriveResourcesSchema(pool);
        await ensureFilesIndexSchema(pool);
        await ensureDocumentArtifactsSchema(pool);
        await ensureAgendaDefinitionSchema();
        await ensureInvitedSubjectSchema(pool);
        await ensureTaskAssignmentSchema(pool);
      },
    },
    {
      name: "library-compatibility",
      run: async () => {
        const { convergeLibraryCompatibilitySchema } = await import("./library-schema");
        await convergeLibraryCompatibilitySchema();
      },
    },
    {
      name: "retired-contracts",
      run: async () => {
        const { retireRegressionDomainSchema } = await import("./migrations/retire-regression-domain");
        await retireRegressionDomainSchema();
      },
    },
  ];

  const startedAt = performance.now();
  log.info("schema convergence started", { reason: "boot", phases: phases.length });
  for (const phase of phases) await runPhase(phase);
  log.info("schema convergence completed", {
    reason: "boot",
    phases: phases.length,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });
}

/** DB Sync delegates baseline table creation to the same convergence owner. */
export async function convergeDbSyncSchema(baselineTables: PgTable[]): Promise<void> {
  await runPhase({
    name: "db-sync-baseline",
    run: () => runSchemaBootstrap("db-sync", baselineTables),
  });
}

/**
 * Expensive concurrent indexes remain post-ready by contract, but their launch,
 * retry owner, and observability are explicitly delegated from this boundary.
 */
export function startPostReadySchemaConvergence(): void {
  void import("./memory/document-search-indexes")
    .then(({ startDocumentStoreSearchIndexMaintenance }) => {
      log.info("post-ready schema convergence delegated", {
        actor: "document-store-search-indexes",
      });
      startDocumentStoreSearchIndexMaintenance();
    })
    .catch((error) => {
      log.warn("post-ready schema convergence unavailable", {
        actor: "document-store-search-indexes",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
}
