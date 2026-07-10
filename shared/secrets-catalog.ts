export type SecretSection =
  | "anthropic"
  | "openai"
  | "claude-cli"
  | "elevenlabs"
  | "brave"
  | "notion"
  | "plaid"
  | "google"
  | "github"
  | "oura"
  | "railway"
  | "expo"
  | "sentry"
  | "recall"
  | "sendgrid"
  | "storage";

export interface SecretSpec {
  name: string;
  section: SecretSection;
  label: string;
  description?: string;
}

export const SECRET_CATALOG: SecretSpec[] = [
  { name: "ANTHROPIC_API_KEY", section: "anthropic", label: "Anthropic API Key", description: "Used for Claude models." },
  { name: "OPENAI_API_KEY", section: "openai", label: "OpenAI API Key", description: "Used for image, audio, and embeddings (api.openai.com). Chat/Codex use the OpenAI Subscription OAuth flow instead." },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", section: "claude-cli", label: "Claude Code OAuth Token", description: "Token for the Claude Code CLI subscription." },
  { name: "ELEVENLABS_API_KEY", section: "elevenlabs", label: "ElevenLabs API Key", description: "Powers voice synthesis and conversational agents." },
  { name: "VOICE_V3_WEBHOOK_SECRET", section: "elevenlabs", label: "Voice V3 Webhook Secret", description: "Shared secret ElevenLabs sends on every V3 (native-LLM) tool webhook call. Set here to avoid an env var + redeploy. Required in production." },
  { name: "ELEVENLABS_AGENT_ID", section: "elevenlabs", label: "ElevenLabs Agent ID", description: "Conversational AI agent ID. Required for voice sessions." },
  { name: "BRAVE_API_KEY", section: "brave", label: "Brave Search API Key", description: "Enables web search." },
  { name: "NOTION_API_KEY", section: "notion", label: "Notion API Key", description: "Optional global Notion integration token." },
  { name: "PLAID_CLIENT_ID", section: "plaid", label: "Plaid Client ID" },
  { name: "PLAID_SECRET", section: "plaid", label: "Plaid Secret" },
  { name: "PLAID_ENV", section: "plaid", label: "Plaid Environment", description: "sandbox | development | production" },
  { name: "GOOGLE_CLIENT_ID", section: "google", label: "Google OAuth Client ID" },
  { name: "GOOGLE_CLIENT_SECRET", section: "google", label: "Google OAuth Client Secret" },
  { name: "EXPO_ACCESS_TOKEN", section: "expo", label: "Expo Access Token", description: "Personal access token from expo.dev/accounts/[account]/settings/access-tokens. Enables EAS builds, project linking, and deployment status." },
  { name: "EXPO_PUBLIC_SENTRY_DSN", section: "sentry", label: "Sentry DSN", description: "Client-safe DSN used by the mobile app to send crash reports to Sentry." },
  { name: "SENTRY_AUTH_TOKEN", section: "sentry", label: "Sentry Auth Token", description: "Secret token used by EAS/Sentry tooling to upload source maps and debug artifacts. Store as an EAS secret too." },
  { name: "SENTRY_ORG", section: "sentry", label: "Sentry Organization Slug", description: "Sentry organization slug used by the Expo/Sentry config plugin and source-map upload tooling." },
  { name: "SENTRY_PROJECT", section: "sentry", label: "Sentry Project Slug", description: "Sentry project slug for the mobile app crash-reporting project." },
  { name: "RECALL_API_KEY", section: "recall", label: "Recall.ai API Key", description: "API key from the Recall.ai dashboard (region-specific). Powers the meeting bot: joining Zoom/Meet calls and streaming live transcripts." },
  { name: "RECALL_REGION", section: "recall", label: "Recall.ai Region", description: "Region of your Recall.ai workspace: us-east-1 | us-west-2 | eu-central-1 | ap-northeast-1. Determines the API base URL (https://{region}.recall.ai)." },
  { name: "RECALL_WEBHOOK_SECRET", section: "recall", label: "Recall.ai Webhook Signing Secret", description: "Svix signing secret (whsec_...) from the Recall.ai dashboard Webhooks page. Used to verify bot status and real-time transcript webhook signatures." },
  { name: "SENDGRID_API_KEY", section: "sendgrid", label: "SendGrid API Key", description: "Server-side API key for Twilio SendGrid Mail Send." },
  { name: "SENDGRID_FROM_EMAIL", section: "sendgrid", label: "Verified From Email", description: "Default verified sender email or authenticated domain sender used for outbound notifications." },
  { name: "SENDGRID_FROM_NAME", section: "sendgrid", label: "From Name", description: "Optional display name for Mantra outbound notifications." },
  { name: "OURA_CLIENT_ID", section: "oura", label: "Oura Client ID", description: "OAuth client ID from the Oura Cloud API Application settings." },
  { name: "OURA_CLIENT_SECRET", section: "oura", label: "Oura Client Secret", description: "OAuth client secret from the Oura Cloud API Application settings." },
  { name: "OURA_WEBHOOK_VERIFY_TOKEN", section: "oura", label: "Oura Webhook Verify Token", description: "Shared verification token used by the Oura webhook callback. Generate a long random value and configure the same value in Oura Cloud." },
  // GITHUB_TOKEN removed — migrated to github_credentials table (multi-credential system)
  { name: "RAILWAY_API_TOKEN", section: "railway", label: "Railway API Token", description: "Personal Access Token from railway.com/account/tokens (NOT a project or team token — those can't list projects). Saving here overrides any host RAILWAY_API_TOKEN env var." },
  { name: "RAILWAY_PROJECT_ID", section: "railway", label: "Railway Project ID", description: "ID of the Railway project that hosts the Mantra dev/stage instance." },
  { name: "RAILWAY_DEV_ENVIRONMENT_ID", section: "railway", label: "Railway Dev Environment ID", description: "Environment ID inside the project (e.g. 'dev' or 'preview') that the Dev page should target." },
  { name: "RAILWAY_DEV_SERVICE_ID", section: "railway", label: "Railway Dev Service ID (optional override)", description: "Optional. Auto-resolved from the project + environment when there is exactly one app service. Set this only to pin a specific service when the project has multiple app services." },
  { name: "RAILWAY_DEV_URL", section: "railway", label: "Railway Dev URL (optional override)", description: "Optional. Auto-resolved from the dev service's generated *.up.railway.app domain. Set this only to pin a custom domain or override the auto-detected one." },
  { name: "RAILWAY_PROD_ENVIRONMENT_ID", section: "railway", label: "Railway Prod Environment ID", description: "Environment ID inside the project that the Publish tab promotes to. Required for the Publish flow." },
  { name: "RAILWAY_PROD_SERVICE_ID", section: "railway", label: "Railway Prod Service ID", description: "Service ID for the prod app inside the prod environment. Usually the same service id as dev when both environments share one service." },
  { name: "RAILWAY_PROD_URL", section: "railway", label: "Railway Prod URL", description: "Public URL of the prod Railway service. Used by the Publish tab's post-deploy health check." },
  { name: "RAILWAY_LIVE_BRANCH", section: "railway", label: "Live branch (Publish target)", description: "Optional. Git branch the Railway prod service deploys from. Defaults to 'live'." },
  { name: "S3_BUCKET", section: "storage", label: "S3 Bucket Name", description: "Name of the S3-compatible bucket used for object storage (uploads, generated files, indexed content). Single bucket; the app writes under 'public/' and 'private/' key prefixes." },
  { name: "S3_REGION", section: "storage", label: "S3 Region", description: "Region of the bucket (e.g. 'us-east-1'). For Railway Buckets and most S3-compatible providers any value is accepted but it must be set." },
  { name: "S3_ENDPOINT", section: "storage", label: "S3 Endpoint URL", description: "Custom endpoint URL (e.g. https://<bucket>.railway.app or https://<account>.r2.cloudflarestorage.com). Required for Railway Buckets, R2, MinIO, Backblaze B2. Leave blank for AWS S3." },
  { name: "S3_ACCESS_KEY_ID", section: "storage", label: "S3 Access Key ID", description: "Access key id for the bucket credentials." },
  { name: "S3_SECRET_ACCESS_KEY", section: "storage", label: "S3 Secret Access Key", description: "Secret access key paired with the access key id." },
  { name: "S3_FORCE_PATH_STYLE", section: "storage", label: "S3 Force Path-Style Addressing", description: "Set to 'true' to use path-style URLs (https://endpoint/bucket/key) instead of virtual-host style. Required for Railway Buckets and MinIO; usually 'false' for AWS S3 and Cloudflare R2." },
];

export const SECRET_NAMES: string[] = SECRET_CATALOG.map(s => s.name);

export function isKnownSecretName(name: string): boolean {
  return SECRET_NAMES.includes(name);
}

export function getSecretSpec(name: string): SecretSpec | undefined {
  return SECRET_CATALOG.find(s => s.name === name);
}

export type SecretStatus = "set" | "not_set" | "invalid";

export interface SecretMetadata {
  name: string;
  section: SecretSection;
  label: string;
  description?: string;
  isSet: boolean;
  status: SecretStatus;
  source: "db" | "env" | "none";
  last4: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const BOOTSTRAP_ENV_NOTE = "DATABASE_URL, SESSION_SECRET, and ENCRYPTION_KEY are loaded from the host environment by design — they are required before the app can read its own database.";
