import { apiRequest, queryClient } from "@/lib/queryClient";

export interface StartupOnboardingStatus {
  completed: boolean;
  onboardingStatus: string;
  ftueSessionId?: string;
  profile?: {
    displayName?: string | null;
    preferredName?: string | null;
    timezone?: string | null;
  } | null;
}

// Ceiling for the recap onboarding write (DB-only: recipient recap
// materialization + workspace provisioning). It gates the FTUE deep link, so a
// slow-but-successful write must not abort and strand the visitor on a bare Home
// with no FTUE. The wait happens over the live entrance orb, never dead black.
const ONBOARDING_TIMEOUT_MS = 30_000;

/**
 * Canonical destination after startup onboarding completes. Home remains the
 * real app surface while the ordinary session deep link selects the FTUE
 * conversation and starts authenticated voice inside the canonical AppShell.
 */
export function getStartupOnboardingDestination(status: StartupOnboardingStatus): string {
  const params = new URLSearchParams();
  if (status.ftueSessionId) {
    params.set("c", status.ftueSessionId);
    params.set("autoVoice", "1");
  }
  const query = params.toString();
  return `/home${query ? `?${query}` : ""}`;
}

export async function completeStartupOnboarding(
  name: string,
  options?: { recapToken?: string },
): Promise<StartupOnboardingStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONBOARDING_TIMEOUT_MS);

  try {
    const res = await apiRequest("POST", "/api/onboarding/complete", {
      name: name.trim(),
      ...(options?.recapToken ? { recapToken: options.recapToken } : {}),
    }, controller.signal);
    const status = await res.json() as StartupOnboardingStatus;
    queryClient.setQueryData(["/api/onboarding/status"], status);
    void queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    localStorage.removeItem("xyz_onboarding_complete");
    localStorage.removeItem("onboarding_skipped");
    return status;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("Onboarding timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
