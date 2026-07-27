import { createLogger } from "../log";
import type { RuntimeIdentity } from "../runtime-identity";
import { requestIndependentDocumentStoreActivation } from "./document-store-cutover";

const log = createLogger("StageDocumentStoreActivation");
const MANTRA_WEB_STAGE_ENVIRONMENT_ID = 11;

/**
 * Request the one-way document-store epoch only after the exact stage binary
 * has completed readiness. The next child boot owns reconciliation and the
 * guarded transition; this hook never enables independent writes directly.
 */
export async function requestStageDocumentStoreActivationAfterReadiness(
  runtimeIdentity: RuntimeIdentity,
): Promise<"not_stage" | "restart_requested" | "already_requested" | "already_enabled"> {
  if (runtimeIdentity.platformEnvironmentId !== MANTRA_WEB_STAGE_ENVIRONMENT_ID) {
    return "not_stage";
  }

  const outcome = await requestIndependentDocumentStoreActivation();
  if (outcome !== "requested") {
    log.info("stage document-store activation rollout already converged", { outcome });
    return outcome;
  }

  if (typeof process.send !== "function") {
    throw new Error("Stage document-store activation requires the supervised process wrapper");
  }

  await new Promise<void>((resolve, reject) => {
    process.send!(
      { type: "planned_restart", reason: "stage_document_store_activation" },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  log.info("stage document-store activation persisted; planned restart requested");
  return "restart_requested";
}
