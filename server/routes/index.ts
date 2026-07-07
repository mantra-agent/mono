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
import { registerCaptureRoutes } from "./captures";
import { registerEmailRoutes } from "./email";
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
import { registerHomeRoutes } from "./home";
import mediaRoutes from "../media/media-routes";
import renderRoutes from "../media/render-routes";

/**
 * API path aliases — canonical new names rewrite to legacy handler paths.
 * Old paths remain for backward compatibility (mobile, stored references).
 * Remove aliases once all consumers migrate to canonical paths.
 */
const API_PATH_ALIASES: [string, string][] = [
  ["/api/projects", "/api/work"],       // Domain 2: Work → Projects
  ["/api/observations", "/api/thoughts"], // Domain 6: Thoughts → Observations
  ["/api/home", "/api/simple"],          // Domain 1: Simple → Home
];

export async function registerDomainRoutes(
  app: Express,
  serverStartTime: Date,
  wss: WebSocketServer,
  eventsWss: WebSocketServer
) {
  // Rewrite canonical API paths to legacy handler paths before any route matching.
  // Both old and new paths work; old paths are kept for mobile/stored-reference compat.
  app.use((req, _res, next) => {
    for (const [canonical, legacy] of API_PATH_ALIASES) {
      if (req.url.startsWith(canonical + "/") || req.url === canonical) {
        req.url = legacy + req.url.slice(canonical.length);
        req.originalUrl = legacy + req.originalUrl.slice(req.originalUrl.indexOf(canonical) + canonical.length);
        break;
      }
    }
    next();
  });

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
  app.use(["/api/gmail", "/api/email", "/api/email-drafts", "/api/goals", "/api/import-queue"], requireAuth);

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
  registerCaptureRoutes(app);
  registerEmailRoutes(app);
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
  registerMobileTelemetryRoutes(app);
  registerMobileDATDebugRoutes(app);
  app.use("/api/media", mediaRoutes);
  app.use("/api/render", renderRoutes);
}
