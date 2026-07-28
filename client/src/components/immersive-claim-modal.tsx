import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createLogger } from "@/lib/logger";

const log = createLogger("ImmersiveClaimModal");

interface ClaimResolveResponse {
  email: string;
  displayName: string;
  meetingTitle?: string;
}

interface ImmersiveClaimModalProps {
  onboardingToken: string;
  /** Fired once the claim succeeds and the authenticated session is established. */
  onClaimed: () => void;
}

/**
 * Non-blocking account-claim affordance that floats over the persistent orb in
 * immersive-orb presentation mode.
 *
 * It is a persistent affordance, NOT a gate. The full-area wrapper is
 * `pointer-events-none` so the live orb/voice session behind it stays fully
 * interactive; only the card itself captures pointer input. The modal never
 * touches the voice session (start / mute / end are owned entirely by
 * `VoiceSessionProvider`), so a spoken product question is answered by the
 * provisional agent while the form waits.
 *
 * On success it establishes the authenticated session by seeding the
 * `/api/auth/me` query cache — matching the login/register handoff, which
 * deliberately does NOT immediately refetch and race the cookie handoff — then
 * calls `onClaimed` WITHOUT a page reload, so the orb component instance is
 * never remounted (FR-17).
 */
export function ImmersiveClaimModal({ onboardingToken, onClaimed }: ImmersiveClaimModalProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // React state setters are async; a synchronous ref is the concurrency lock so
  // a double-submit in the same tick cannot fire two claim requests.
  const submittingRef = useRef(false);

  // Prefill from the token: locked email + attendee name. Pure read, no mutation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiRequest("POST", "/api/auth/claim/resolve", { token: onboardingToken });
        const data = (await res.json()) as ClaimResolveResponse;
        if (cancelled) return;
        setEmail(data.email);
        if (data.displayName) setName(data.displayName);
      } catch (err) {
        // A resolve failure does not block the affordance. The email stays empty
        // and the server-side claim guard remains the authoritative check.
        log.warn("resolve_failed", { message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onboardingToken]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setError(null);

    if (!name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (!password || !confirmPassword) {
      setError("Enter and confirm a password.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/auth/claim", {
        token: onboardingToken,
        name: name.trim(),
        password,
      });
      const data = await res.json();
      queryClient.setQueryData(["/api/auth/me"], data);
      onClaimed();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // apiRequest throws `${status}: ${body}`.
      const friendly = message.startsWith("409")
        ? "An account already exists for this invitation. Please log in."
        : "Could not create your account. Please try again.";
      setError(friendly);
      log.warn("claim_failed", { message });
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center p-6 sm:items-center">
      <form
        onSubmit={handleSubmit}
        className="pointer-events-auto w-full max-w-sm rounded-lg border border-card-border bg-card/95 p-6 shadow-xl backdrop-blur"
        aria-label="Create your Mantra account"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-foreground">Make it yours</h2>
            <p className="text-sm text-muted-foreground">
              Keep this conversation and everything it captured. Create your account to pick up
              where you left off.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claim-name">Name</Label>
            <Input
              id="claim-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claim-email">Email</Label>
            <Input
              id="claim-email"
              type="email"
              value={email}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
              className="cursor-not-allowed bg-muted text-muted-foreground"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claim-password">Password</Label>
            <Input
              id="claim-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="claim-confirm">Confirm password</Label>
            <Input
              id="claim-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Creating account…" : "Create account"}
          </Button>
        </div>
      </form>
    </div>
  );
}
