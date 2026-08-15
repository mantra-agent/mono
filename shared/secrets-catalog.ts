export type SecretSection =
  | "anthropic"
  | "openai"
  | "claude-cli"
  | "elevenlabs"
  | "cartesia"
  | "brave"
  | "notion"
  | "plaid"
  | "quickbooks"
  | "google"
  | "box"
  | "github"
  | "oura"
  | "railway"
  | "expo"
  | "sentry"
  | "recall"
  | "twilio"
  | "deepgram"
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
  { name: "ELEVENLABS_API_KEY", section: "elevenlabs", label: "ElevenLabs API Key", description: "Powers voice synthesis and conversational agents. Also serves as the meeting TTS fallback." },
  { name: "CARTESIA_API_KEY", section: "cartesia", label: "Cartesia API Key", description: "Primary meeting-agent text-to-speech provider." },
  { name: "CARTESIA_VOICE_ID", section: "cartesia", label: "Cartesia Voice ID", description: "Voice used when the meeting agent speaks. Copy an ID from the Cartesia Voices page." },
  { name: "ELEVENLABS_AGENT_ID", section: "elevenlabs", label: "ElevenLabs Agent ID", description: "Conversational AI agent ID. Required for voice sessions." },
  { name: "BRAVE_API_KEY", section: "brave", label: "Brave Search API Key", description: "Enables web search." },
  { name: "NOTION_API_KEY", section: "notion", label: "Notion API Key", description: "Optional global Notion integration token." },
  { name: "PLAID_CLIENT_ID", section: "plaid", label: "Plaid Client ID" },
  { name: "PLAID_SECRET", section: "plaid", label: "Plaid Secret" },
  { name: "PLAID_ENV", section: "plaid", label: "Plaid Environment", description: "sandbox | development | production" },
  { name: "QUICKBOOKS_CLIENT_ID", section: "quickbooks", label: "QuickBooks OAuth Client ID" },
  { name: "QUICKBOOKS_CLIENT_SECRET", section: "quickbooks", label: "QuickBooks OAuth Client Secret" },
  { name: "QUICKBOOKS_ENV", section: "quickbooks", label: "QuickBooks Environment", description: "sandbox | production" },
  { name: "GOOGLE_CLIENT_ID", section: "google", label: "Google OAuth Client ID" },
  { name: "GOOGLE_CLIENT_SECRET", section: "google", label: "Google OAuth Client Secret" },
  {
    name: "GOOGLE_PICKER_API_KEY",
    section: "google",
    label: "Google Picker API Key",
    description: "Browser key for the Google Picker SDK (Drive file chooser). Distinct from the OAuth client ID.",
  },
  { name: "BOX_CLIENT_ID", section: "box", label: "Box OAuth Client ID", description: "Client ID from the Box Developer Console OAuth 2.0 app." },
  { name: "BOX_CLIENT_SECRET", section: "box", label: "Box OAuth Client Secret", description: "Client secret from the Box Developer Console OAuth 2.0 app. Store here — not in Railway." },
  {
    name: "BOX_REDIRECT_URI",
    section: "box",
    label: "Box OAuth Redirect URI",
    description: "Optional exact callback override. Leave blank to use https://{host}/api/box/oauth/callback for the current host.",
  },
  { name: "EXPO_ACCESS_TOKEN", section: "expo", label: "Expo Access Token", description: "Personal access token from expo.dev/accounts/[account]/settings/access-tokens. Enables EAS builds, project linking, and deployment status." },
  { name: "SENTRY_DSN", section: "sentry", label: "Sentry DSN", description: "Client-safe project DSN. One value arms web, mobile, and server crash capture. EXPO_PUBLIC_SENTRY_DSN remains a mobile build-time alias." },
  { name: "EXPO_PUBLIC_SENTRY_DSN", section: "sentry", label: "Sentry DSN (mobile build alias)", description: "Optional mobile build-time alias of SENTRY_DSN. Runtime mobile/web/server resolve SENTRY_DSN first, then this alias." },
  { name: "SENTRY_AUTH_TOKEN", section: "sentry", label: "Sentry Auth Token", description: "Secret token for Sentry API (issues/uptime) and source-map upload tooling. Store as an EAS secret too when uploading mobile maps." },
  { name: "SENTRY_ORG", section: "sentry", label: "Sentry Organization Slug", description: "Sentry organization slug for API access and Expo/Sentry source-map tooling." },
  { name: "SENTRY_PROJECT", section: "sentry", label: "Sentry Project Slug", description: "Sentry project slug for crash reporting, issues, and uptime results. Prefer one project for web+mobile+server with surface tags." },
  { name: "SENTRY_UPTIME_QUERY", section: "sentry", label: "Uptime Result Filter", description: "Optional bounded Sentry Explore query used to isolate the Live uptime monitor when a project has more than one monitor." },
  { name: "RECALL_API_KEY", section: "recall", label: "Recall.ai API Key", description: "API key from the Recall.ai dashboard (region-specific). Powers the meeting bot: joining Zoom/Meet calls and streaming live transcripts." },
  { name: "RECALL_REGION", section: "recall", label: "Recall.ai Region", description: "Region of your Recall.ai workspace: us-east-1 | us-west-2 | eu-central-1 | ap-northeast-1. Determines the API base URL (https://{region}.recall.ai)." },
  { name: "RECALL_WEBHOOK_SECRET", section: "recall", label: "Recall.ai Status Webhook Secret", description: "Svix signing secret (whsec_...) from the Recall.ai dashboard Webhooks endpoint. Used for bot lifecycle status events." },
  { name: "RECALL_WORKSPACE_VERIFICATION_SECRET", section: "recall", label: "Recall.ai Workspace Verification Secret", description: "Workspace secret (whsec_...) from Developers > API Keys & Secrets. Used for real-time transcript endpoints and callbacks. Legacy Recall workspaces require this separately from the status webhook secret." },
  { name: "TWILIO_ACCOUNT_SID", section: "twilio", label: "Twilio Account SID", description: "AC-prefixed Account SID from the Twilio Console." },
  { name: "TWILIO_AUTH_TOKEN", section: "twilio", label: "Twilio Auth Token", description: "Primary auth token paired with the Account SID. Keep it server-side." },
  { name: "TWILIO_PHONE_NUMBER", section: "twilio", label: "Twilio Phone Number", description: "Purchased Twilio phone number in E.164 format, such as +13125551234." },
  { name: "DEEPGRAM_API_KEY", section: "deepgram", label: "Deepgram API Key", description: "Server-side API key for Nova-3 streaming speech recognition." },
  { name: "SENDGRID_API_KEY", section: "sendgrid", label: "SendGrid API Key", description: "Server-side API key for Twilio SendGrid Mail Send." },
  { name: "SENDGRID_FROM_EMAIL", section: "sendgrid", label: "Verified From Email", description: "Default verified sender email or authenticated domain sender used for outbound notifications." },
  { name: "SENDGRID_FROM_NAME", section: "sendgrid", label: "From Name", description: "Optional display name for Mantra outbound notifications." },
  { name: "OURA_CLIENT_ID", section: "oura", label: "Oura Client ID", description: "OAuth client ID from the Oura Cloud API Application settings." },
  { name: "OURA_CLIENT_SECRET", section: "oura", label: "Oura Client Secret", description: "OAuth client secret from the Oura Cloud API Application settings." },
  { name: "OURA_WEBHOOK_VERIFY_TOKEN", section: "oura", label: "Oura Webhook Verify Token", description: "Private verification token sent to Oura when Mantra creates webhook subscriptions. Generate a random value of at least 32 characters; do not add it to the Oura Developer Application." },
  // GitHub credentials are owned by encrypted Platform provider connections.
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
