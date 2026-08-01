// Standalone production-build validation entry (spec §6.1). Bundled and
// executed by script/build.ts so first-party Mod registry collisions or
// dangling references fail the build, not just server startup. Pure: it
// evaluates the code-owned registry and validator with no database or network.
import { assertModRegistryValid } from "./index";

try {
  assertModRegistryValid();
  console.log("[mod-registry] build-time validation passed");
} catch (err) {
  console.error(`[mod-registry] build-time validation FAILED`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
