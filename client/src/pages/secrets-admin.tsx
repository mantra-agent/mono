import { KeyRound } from "lucide-react";
import { SecretsForSection } from "@/components/SecretControl";
import { ProfileDetailSection } from "@/components/profile-detail-section";

export default function SecretsAdminPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Secrets</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          System credentials used by shared integrations. Values are encrypted and never displayed after saving.
        </p>
      </div>

      <ProfileDetailSection title="Google OAuth" defaultOpen testId="secrets-section-google-oauth">
        <SecretsForSection section="google" />
      </ProfileDetailSection>
    </div>
  );
}
