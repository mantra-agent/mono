import { KeyRound } from "lucide-react";
import { SecretsForSection } from "@/components/SecretControl";

export default function SecretsAdminPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Secrets</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          System credentials used by shared integrations. Values are encrypted and never displayed after saving.
        </p>
      </div>

      <section className="space-y-3 rounded-lg border bg-card p-5">
        <div>
          <h2 className="font-medium">Google OAuth</h2>
          <p className="text-sm text-muted-foreground">
            OAuth client credentials used to connect Google accounts across Mantra.
          </p>
        </div>
        <SecretsForSection section="google" />
      </section>
    </div>
  );
}
