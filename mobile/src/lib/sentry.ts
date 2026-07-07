import { reportSentryStatus } from './startup-telemetry';
import Constants from 'expo-constants';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

// Lazy reference — only populated when DSN is configured and Sentry is loaded.
let SentryModule: typeof import('@sentry/react-native') | null = null;

/**
 * Initialize Sentry crash reporting.
 *
 * IMPORTANT: We must NOT import @sentry/react-native at module scope.
 * The SDK registers default integrations at import time, including
 * ExpoUpdatesListener which does `require('expo-updates')`. Since
 * expo-updates is not installed, Metro compiles that to `require(undefined)`,
 * which throws a fatal "Requiring unknown module" error on Hermes
 * before any try/catch can intercept it.
 *
 * By deferring the import to initSentry() and only loading when DSN
 * is present, we avoid the crash entirely when Sentry isn't configured.
 */
export function initSentry() {
  const missing: string[] = [];
  if (!dsn) missing.push('EXPO_PUBLIC_SENTRY_DSN');

  if (missing.length > 0) {
    reportSentryStatus(false, missing);
    return;
  }

  // Only import the heavy SDK when we actually have a DSN.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SentryModule = require('@sentry/react-native');

  const extra = Constants.expoConfig?.extra?.metaWearables;
  const gitSha = extra?.gitCommitSha || 'unknown';
  const buildProfile = extra?.easBuildProfile || 'unknown';

  SentryModule!.init({
    dsn,
    debug: __DEV__,
    enabled: !__DEV__,
    tracesSampleRate: 0.2,
    // Exclude the ExpoUpdatesListener integration since expo-updates
    // is not installed. Without this, the SDK tries to require it
    // and crashes on Hermes.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'ExpoUpdatesListener'),
    beforeSend(event) {
      // Tag every event with commit SHA and build profile for traceability.
      event.tags = {
        ...event.tags,
        'git.commit': gitSha,
        'build.profile': buildProfile,
      };
      return event;
    },
  });

  reportSentryStatus(true);
}

/**
 * Sentry navigation integration for React Navigation.
 * Wire this into the navigation container's onReady / ref
 * to get automatic screen-change breadcrumbs.
 *
 * Returns undefined if Sentry hasn't been initialized.
 */
export function getSentryNavigationIntegration() {
  if (!SentryModule) return undefined;
  return SentryModule.reactNavigationIntegration({
    enableTimeToInitialDisplay: true,
  });
}
