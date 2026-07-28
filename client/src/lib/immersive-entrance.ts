/**
 * Canonical URL contract for the provisional immersive-orb voice entrance.
 *
 * The recap distribution server bounces a provisional (not-yet-registered)
 * recipient to the marketing landing root with `?i=<onboardingToken>`, which
 * lands the in-app URL `/visualizer?i=<onboardingToken>`. That URL renders the
 * app shell in immersive-orb presentation mode (see `AppShellImmersive`) rather
 * than the standalone Recall meeting visualizer.
 *
 * The Recall meeting-bot visualizer (`/visualizer?token=<meetingToken>`) and the
 * design preview (`/visualizer?state=...`) keep their lightweight standalone
 * render root and are intentionally excluded here.
 *
 * This module is the single source of truth for detecting the provisional
 * entrance so `main.tsx` (pre-React entry fork) and `App.tsx` (in-app shell
 * selection) can never disagree about which URL owns the shell.
 */

const IMMERSIVE_ENTRANCE_PATH = "/visualizer";

/**
 * Returns the provisional onboarding token when the current location is the
 * provisional immersive-orb voice entrance, otherwise `null`.
 *
 * A provisional entrance requires the `/visualizer` path, a non-empty `i`
 * onboarding token, and NO meeting `token` (a meeting token is the Recall
 * visualizer, which must stay on the standalone root).
 */
export function getProvisionalOnboardingToken(
  location: { pathname: string; search: string } = window.location,
): string | null {
  if (location.pathname !== IMMERSIVE_ENTRANCE_PATH) return null;
  const params = new URLSearchParams(location.search);
  const onboardingToken = params.get("i")?.trim() ?? "";
  const meetingToken = params.get("token")?.trim() ?? "";
  if (!onboardingToken || meetingToken) return null;
  return onboardingToken;
}

/** True when the current location is the provisional immersive-orb entrance. */
export function isProvisionalImmersiveEntrance(
  location: { pathname: string; search: string } = window.location,
): boolean {
  return getProvisionalOnboardingToken(location) !== null;
}
