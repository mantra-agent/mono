import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { MantraLogo } from "@/components/mantra-logo";
import {
  authButtonClass,
  authFormClass,
  authInputClass,
  authLinkClass,
  authLogoClass,
  authShellClass,
  authTitleClass,
} from "@/lib/auth-layout";

/** Enumeration-safe acknowledgement — identical for hit and miss. */
export const FORGOT_PASSWORD_ACK =
  "If we found your email, you will receive a reset password link shortly.";

export default function ForgotPasswordPage() {
  const [, setLocation] = useLocation();
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => emailRef.current?.focus({ preventScroll: true }));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    // Empty email is a pure no-op: no request, no loading, no modal.
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/auth/forgot-password", { email: trimmed });
    } catch {
      // Route is enumeration-safe and should always 200; transport failure still gets the same ack.
    } finally {
      setSubmitting(false);
      setAckOpen(true);
    }
  };

  return (
    <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
      <div className={authShellClass}>
        <div className="flex h-24 justify-center">
          <MantraLogo className={authLogoClass} />
        </div>
        <h1 className={authTitleClass}>Forgot password</h1>
        <form onSubmit={handleSubmit} className={authFormClass}>
          <div className="space-y-2">
            <Input
              ref={emailRef}
              id="forgot-password-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email..."
              autoComplete="email"
              className={authInputClass}
              data-testid="input-forgot-password-email"
            />
          </div>
          <div className="space-y-4">
            <Button
              type="submit"
              className={authButtonClass}
              disabled={submitting}
              data-testid="button-forgot-password-submit"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send reset link"}
            </Button>
            <Button
              type="button"
              variant="link"
              className={authLinkClass}
              onClick={() => setLocation("/login")}
              data-testid="link-forgot-password-sign-in"
            >
              Back to sign in
            </Button>
          </div>
        </form>
      </div>

      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-forgot-password-ack">
          <DialogHeader>
            <DialogTitle>Check your email</DialogTitle>
            <DialogDescription>{FORGOT_PASSWORD_ACK}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              className={authButtonClass}
              onClick={() => {
                setAckOpen(false);
                setLocation("/login");
              }}
              data-testid="button-forgot-password-ack-done"
            >
              Back to sign in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
