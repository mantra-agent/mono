import { SecretsForSection } from "@/components/SecretControl";
import { VoiceV3WebhookSecretCard } from "@/components/VoiceV3WebhookSecretCard";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { usePageHeader } from "@/hooks/use-page-header";

export default function SecretsAdminPage() {
  usePageHeader({ title: "Secrets", titleHref: "/secrets" });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <ProfileDetailSection title="Google OAuth" defaultOpen testId="secrets-section-google-oauth">
        <SecretsForSection section="google" />
      </ProfileDetailSection>

      <ProfileDetailSection title="ElevenLabs" defaultOpen testId="secrets-section-elevenlabs">
        <SecretsForSection section="elevenlabs" excludeNames={["VOICE_V3_WEBHOOK_SECRET"]} />
        <VoiceV3WebhookSecretCard />
      </ProfileDetailSection>
    </div>
  );
}
