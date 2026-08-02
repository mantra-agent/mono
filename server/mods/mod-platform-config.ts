/**
 * Single environment-level rollback switch for every Mod composition and
 * execution boundary. Default ON; explicit false disables the platform.
 */
export function isModPlatformEnabled(): boolean {
  return process.env.MOD_PLATFORM_ENABLED !== "false";
}
