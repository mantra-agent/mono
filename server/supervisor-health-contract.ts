import { randomBytes, timingSafeEqual } from "crypto";

export const SUPERVISOR_HEALTH_PATH = "/api/health/supervisor";
export const SUPERVISOR_HEALTH_HEADER = "x-mantra-supervisor-health";
export const SUPERVISOR_HEALTH_TOKEN_ENV = "MANTRA_SUPERVISOR_HEALTH_TOKEN";

const SUPERVISOR_HEALTH_TOKEN_BYTES = 32;
const expectedSupervisorHealthToken = process.env[SUPERVISOR_HEALTH_TOKEN_ENV];
if (expectedSupervisorHealthToken) delete process.env[SUPERVISOR_HEALTH_TOKEN_ENV];

export function createSupervisorHealthToken(): string {
  return randomBytes(SUPERVISOR_HEALTH_TOKEN_BYTES).toString("base64url");
}

export function isLoopbackSupervisorAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isValidSupervisorHealthToken(candidate: string | undefined): boolean {
  if (!candidate || !expectedSupervisorHealthToken) return false;

  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expectedSupervisorHealthToken, "utf8");
  return candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer);
}
