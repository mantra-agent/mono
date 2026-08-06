import { SecretsForSection } from "@/components/SecretControl";
import { VoiceV3WebhookSecretCard } from "@/components/VoiceV3WebhookSecretCard";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { usePageHeader } from "@/hooks/use-page-header";

export default function SecretsAdminPage() {
  usePageHeader({ title: "Secrets", titleHref: "/secrets" });

  return (
    <div className="w-full space-y-4 p-6">
      <ProfileDetailSection title="Google OAuth" defaultOpen testId="secrets-section-google-oauth">
        <SecretsForSection section="google" />
      </ProfileDetailSection>

      <ProfileDetailSection title="ElevenLabs" defaultOpen testId="secrets-section-elevenlabs">
        <SecretsForSection section="elevenlabs" excludeNames={["VOICE_V3_WEBHOOK_SECRET"]} />
        <VoiceV3WebhookSecretCard />
      </ProfileDetailSection>

      <ProfileDetailSection title="Cartesia" defaultOpen testId="secrets-section-cartesia">
        <SecretsForSection section="cartesia" />
      </ProfileDetailSection>

      <ProfileDetailSection title="Deepgram" defaultOpen testId="secrets-section-deepgram">
        <SecretsForSection section="deepgram" />
      </ProfileDetailSection>

      <ProfileDetailSection title="Brave Search" defaultOpen testId="secrets-section-brave">
        <SecretsForSection section="brave" />
      </ProfileDetailSection>

      <ProfileDetailSection title="SendGrid" defaultOpen testId="secrets-section-sendgrid">
        <SecretsForSection section="sendgrid" />
      </ProfileDetailSection>

      <ProfileDetailSection title="Expo" defaultOpen testId="secrets-section-expo">
        <SecretsForSection section="expo" />
      </ProfileDetailSection>

      <ProfileDetailSection title="Sentry" defaultOpen testId="secrets-section-sentry">
        <SecretsForSection section="sentry" />
      </ProfileDetailSection>
    </div>
  );
}
