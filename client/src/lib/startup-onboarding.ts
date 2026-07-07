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

const ONBOARDING_TIMEOUT_MS = 15_000;

export async function completeStartupOnboarding(name: string): Promise<StartupOnboardingStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONBOARDING_TIMEOUT_MS);

  try {
    const res = await apiRequest("POST", "/api/onboarding/complete", { name: name.trim() }, controller.signal);
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
