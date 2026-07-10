import type { Express } from "express";
import type { WebSocketServer } from "ws";
import { requireAuth } from "../auth";

import { registerSetupRoutes } from "./setup";
import { registerGatewayRoutes } from "./gateway";
import { registerWorkspaceRoutes } from "./workspace";
import { registerSystemRoutes } from "./system";
import { registerOrientationRoutes } from "./orientation";
import { registerInferenceRoutes } from "./inference";
import { registerEventsRoutes } from "./events";
import { registerClientPresenceRoutes } from "./client-presence";
import { registerIntegrationsRoutes } from "./integrations";
import { registerOuraRoutes } from "./oura";
import { registerVoiceRoutes } from "./voice";
import { registerBrainRoutes } from "./brain";
import { registerProjectsRoutes } from "./projects";
import { registerOodaRoutes } from "./ooda";
import { registerPlaidRoutes } from "./plaid";
import { registerFinanceRoutes } from "./finance";
import { registerWellnessRoutes } from "./wellness";
import { registerLibraryRoutes } from "./library";
import { registerEmailRoutes } from "./email";
import { registerEmailDraftRoutes } from "./email-drafts";
import { registerSessionDisplayRoutes } from "./session-display";
import { registerContentRoutes } from "./content";
import { registerHooksRoutes } from "./hooks";
import { registerSessionReminderRoutes } from "./session-reminder";
import { registerLibraryReminderRoutes } from "./library-reminder";
import { registerCognitionRoutes } from "./cognition";
import { registerSecretsRoutes } from "./secrets";
import { registerRailwayRoutes } from "../integrations/railway/routes";
import { registerDiagRoutes } from "./diag";
import { registerDbSyncRoutes } from "./db-sync";
import { registerMaintenanceRoutes } from "./maintenance";
import { registerExecRoutes } from "./exec";
import { registerVersionRoutes } from "./version";
import { registerGlassesRoutes } from "../glasses/routes";
import { registerMagicDemoRoutes } from "./magic-demo";
import { registerPlatformRoutes } from "./platforms";
import { registerWorkflowRoutes } from "./workflows";
import { registerGoalRoutes } from "./goal-routes";
import { registerIssueRoutes } from "./issue-routes";
import { registerProviderConnectionRoutes } from "./provider-connections";
import { registerOnboardingRoutes } from "../onboarding";
import { registerMobileTelemetryRoutes } from "./mobile-telemetry";
import { registerMobileDATDebugRoutes } from "./mobile-dat-debug";
import { registerVaultRoutes } from "./vault-routes";
import { registerHomeRoutes } from "./home";
import { registerNotificationRoutes } from "./notifications";
import mediaRoutes from "../media/media-routes";
import renderRoutes from "../media/render-routes";

export async function registerDomainRoutes(
  app: Express,
  serverStartTime: Date,
  wss: WebSocketServer,
  eventsWss: WebSocketServer
) {
  await registerSetupRoutes(app);
  registerOnboardingRoutes(app);
  await registerGatewayRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerSystemRoutes(app, serverStartTime);
  await registerOrientationRoutes(app);
  await registerInferenceRoutes(app, serverStartTime);
  await registerEventsRoutes(app, wss, eventsWss);
  registerClientPresenceRoutes(app);

  // Confirmed user-data leak surfaces: never rely on client-side tab filtering.
  // Prefix gates ensure principal context is established before integration, email,
  // goal/priority, and voice-goal handlers touch principal-scoped storage.
  app.use(["/api/gmail", "/api/email", "/api/email-drafts", "/api/goals", "/api/import-queue", "/api/notifications"], requireAuth);

  await registerIntegrationsRoutes(app);
  await registerOuraRoutes(app);
  await registerVoiceRoutes(app);
  await registerBrainRoutes(app);
  await registerProjectsRoutes(app);
  await registerOodaRoutes(app);
  await registerPlaidRoutes(app);
  await registerFinanceRoutes(app);
  await registerWellnessRoutes(app);
  await registerLibraryRoutes(app);
  registerEmailRoutes(app);
  registerEmailDraftRoutes(app);
  registerSessionDisplayRoutes(app);
  registerContentRoutes(app);
  registerHooksRoutes(app);
  registerSessionReminderRoutes(app);
  registerLibraryReminderRoutes(app);
  await registerCognitionRoutes(app);
  registerSecretsRoutes(app);
  registerRailwayRoutes(app);
  registerDiagRoutes(app);
  registerDbSyncRoutes(app);
  registerMaintenanceRoutes(app);
  registerExecRoutes(app);
  registerVersionRoutes(app);
  registerGlassesRoutes(app);
  registerMagicDemoRoutes(app);
  registerPlatformRoutes(app);
  await registerWorkflowRoutes(app);
  registerGoalRoutes(app);
  registerIssueRoutes(app);
  registerProviderConnectionRoutes(app);
  registerHomeRoutes(app);
  registerNotificationRoutes(app);
  registerMobileTelemetryRoutes(app);
  registerMobileDATDebugRoutes(app);
  registerVaultRoutes(app);
  app.use("/api/media", mediaRoutes);
  app.use("/api/render", renderRoutes);
}
