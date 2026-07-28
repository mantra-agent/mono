import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { ImmersiveOrbSlot } from "@/components/immersive-orb-slot";

interface AppShellImmersiveProps {
  /**
   * Provisional onboarding token. Passed straight through to
   * `VoiceSessionProvider` so the orb slot runs the exact provisional voice
   * flow (mic prompt, greeting, `/api/voice/start`, custom-LLM, hash lease,
   * `toolMode=none`). No User or chat session is created.
   */
  onboardingToken: string;
  /**
   * Reveal the left/right rails around the persistent orb slot. Defaults to
   * hidden: the provisional entrance has no authenticated principal, so only
   * the orb shows on black. The future account-claim step flips this to reveal
   * the rails WITHOUT remounting the center orb slot (FR-17 orb persistence).
   */
  railsVisible?: boolean;
  /** Left rail content, rendered only when `railsVisible`. */
  leftRail?: ReactNode;
  /** Right rail content, rendered only when `railsVisible`. */
  rightRail?: ReactNode;
}

/**
 * The app shell in immersive-orb presentation mode.
 *
 * This is a deliberately lean sibling of the authenticated `AppShell`: it
 * reuses the same rails + center skeleton but does NOT mount the heavy
 * authenticated providers (data sync, focus session, executor status, sidebar),
 * so it can render for a provisional visitor with no authenticated principal.
 *
 * The center region always mounts exactly one `ImmersiveOrbSlot` in a fixed
 * position. Toggling `railsVisible` renders/hides the rail slots around it
 * without changing the center slot's position in the tree, so the orb is a
 * persistent shell slot that survives the future rails reveal without a
 * remount (FR-17).
 */
export function AppShellImmersive({
  onboardingToken,
  railsVisible = false,
  leftRail,
  rightRail,
}: AppShellImmersiveProps) {
  return (
    <VoiceSessionProvider onboardingToken={onboardingToken}>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-black">
        {railsVisible && leftRail ? (
          <aside className="flex h-full shrink-0 flex-col overflow-hidden">{leftRail}</aside>
        ) : null}
        <div className={cn("relative flex min-w-0 flex-1 flex-col overflow-hidden")}>
          <ImmersiveOrbSlot />
        </div>
        {railsVisible && rightRail ? (
          <aside className="flex h-full shrink-0 flex-col overflow-hidden">{rightRail}</aside>
        ) : null}
      </div>
    </VoiceSessionProvider>
  );
}
