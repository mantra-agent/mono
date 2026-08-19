import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { CopyableAuthError, type CopyableAuthErrorState } from "@/components/copyable-auth-error";
import { MantraLogo } from "@/components/mantra-logo";
import { authButtonClass, authFormClass, authInputClass, authLinkClass, authLogoClass, authShellClass, authTitleClass } from "@/lib/auth-layout";

export default function ResetPasswordPage() {
  const params = useParams<{ token: string }>();
  const token = params.token || "";
  const [, setLocation] = useLocation();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(!token);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [authError, setAuthError] = useState<CopyableAuthErrorState | null>(null);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setInvalid(true);
      return;
    }
    fetch(`/api/auth/reset/${encodeURIComponent(token)}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Invalid");
        setInvalid(false);
      })
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (loading || invalid) return;
    requestAnimationFrame(() => passwordRef.current?.focus({ preventScroll: true }));
  }, [loading, invalid]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (password !== confirm) {
      setAuthError({ title: "Passwords do not match" });
      return;
    }
    if (password.length < 8) {
      setAuthError({ title: "Password must be at least 8 characters" });
      return;
    }
    setAuthError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Password reset failed");
      }
      setLocation("/login", { replace: true });
    } catch (error) {
      setAuthError({
        title: error instanceof Error ? error.message : "Password reset failed",
      });
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (invalid) {
    return (
      <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
        <div className={authShellClass}>
          <div className="flex h-24 justify-center">
            <MantraLogo className={authLogoClass} />
          </div>
          <h1 className={authTitleClass}>Link expired</h1>
          <p className="text-center text-sm text-muted-foreground">
            This reset link is invalid or has expired.
          </p>
          <Button
            type="button"
            variant="link"
            className={authLinkClass}
            onClick={() => setLocation("/login")}
            data-testid="button-reset-back-to-login"
          >
            Back to sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen justify-center bg-background p-4 pt-[14vh]">
      <div className={authShellClass}>
        <div className="flex h-24 justify-center">
          <MantraLogo className={authLogoClass} />
        </div>
        <h1 className={authTitleClass}>Set a new password</h1>
        <form onSubmit={handleSubmit} className={authFormClass}>
          <div className="space-y-4">
            <Input
              ref={passwordRef}
              id="reset-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="New password..."
              autoComplete="new-password"
              required
              className={authInputClass}
              data-testid="input-reset-password"
            />
            <Input
              id="reset-password-confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder="Confirm password..."
              autoComplete="new-password"
              required
              className={authInputClass}
              data-testid="input-reset-password-confirm"
            />
          </div>
          {authError ? <CopyableAuthError error={authError} /> : null}
          <div className="space-y-4">
            <Button
              type="submit"
              className={authButtonClass}
              disabled={saving}
              data-testid="button-reset-password-submit"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save password"}
            </Button>
            <Button
              type="button"
              variant="link"
              className={authLinkClass}
              onClick={() => setLocation("/login")}
              data-testid="link-reset-sign-in"
            >
              Back to sign in
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
