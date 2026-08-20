import { SecretsForSection } from "@/components/SecretControl";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { usePageHeader } from "@/hooks/use-page-header";

export default function SecretsAdminPage() {
  usePageHeader({ title: "Secrets", titleHref: "/secrets" });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <ProfileDetailSection title="Google OAuth" defaultOpen testId="secrets-section-google-oauth">
        <SecretsForSection section="google" />
      </ProfileDetailSection>

      <ProfileDetailSection title="Box OAuth" defaultOpen testId="secrets-section-box-oauth">
        <SecretsForSection section="box" />
      </ProfileDetailSection>

      <ProfileDetailSection title="ElevenLabs" defaultOpen testId="secrets-section-elevenlabs">
        <SecretsForSection section="elevenlabs" />
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

      <ProfileDetailSection title="Oura" defaultOpen testId="secrets-section-oura">
        <SecretsForSection section="oura" />
      </ProfileDetailSection>
    </div>
  );
}
