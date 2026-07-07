const DEFAULT_META_BUNDLE_ID = 'com.oniops.firstglasses';
const DEFAULT_META_URL_SCHEME = 'agentglasses';
const DEFAULT_META_UNIVERSAL_LINK_HOST = 'raymondkallmeyer.com';
const IOS_DEPLOYMENT_TARGET = '16.0';

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const bundleIdentifier = process.env.META_WEARABLES_BUNDLE_ID || DEFAULT_META_BUNDLE_ID;
const urlScheme = process.env.META_WEARABLES_URL_SCHEME || DEFAULT_META_URL_SCHEME;
const universalLinkHost = process.env.META_WEARABLES_UNIVERSAL_LINK_HOST || DEFAULT_META_UNIVERSAL_LINK_HOST;
const easBuildProfile = process.env.EAS_BUILD_PROFILE || '';
const gitCommitSha = process.env.EAS_BUILD_GIT_COMMIT_HASH || 'dev';
const associatedDomainsRequested = envFlag('META_WEARABLES_ENABLE_ASSOCIATED_DOMAINS', false);
const enableAssociatedDomainsInPreview = envFlag('META_WEARABLES_ENABLE_ASSOCIATED_DOMAINS_IN_PREVIEW', false);
const enableAssociatedDomains = associatedDomainsRequested && (
  easBuildProfile !== 'preview' || enableAssociatedDomainsInPreview
);
const developerMode = envFlag('META_WEARABLES_DEVELOPER_MODE', true);

const iosConfig = {
  supportsTablet: false,
  bundleIdentifier,
  infoPlist: {
    // Audio background mode is always needed (voice sessions survive phone lock)
    UIBackgroundModes: ['audio'],
    CFBundleDisplayName: 'Mantra',
    CFBundleName: 'Mantra',
    NSMicrophoneUsageDescription: 'Mantra needs microphone access to hear you through your glasses',
    NSCameraUsageDescription: 'Mantra needs camera access to capture quick vision frames from the glasses.',
    NSContactsUsageDescription: 'Mantra uses contacts access to stage selected iOS contacts for review in People.',
    ITSAppUsesNonExemptEncryption: false,
    NSUserActivityTypes: [
      'AskAgentIntent',
      'StartAgentIntent',
      'StartLiveCoachIntent',
      'WhatAmILookingAtIntent',
    ],
    // All MWDAT-specific keys (Bluetooth, external-accessory, URL schemes,
    // background modes, MWDAT dict) are now managed by withMetaDAT plugin
  },
};

// Build withMetaDAT plugin options from env vars
const metaDATPluginOptions = {
  urlScheme,
  bundleIdentifier,
  universalLinkHost,
  metaAppId: developerMode ? '0' : (process.env.META_WEARABLES_APP_ID || '0'),
  damEnabled: true,
  enableAssociatedDomains,
  sdkVersion: '0.7.0',
};

if (!developerMode) {
  const clientToken = process.env.META_WEARABLES_CLIENT_TOKEN;
  const teamId = process.env.META_WEARABLES_TEAM_ID;
  const missing = [];
  if (!clientToken) missing.push('META_WEARABLES_CLIENT_TOKEN');
  if (!teamId) missing.push('META_WEARABLES_TEAM_ID');
  if (missing.length > 0) {
    throw new Error(`${missing.join(', ')} required when META_WEARABLES_DEVELOPER_MODE=false`);
  }
  metaDATPluginOptions.clientToken = clientToken;
  metaDATPluginOptions.teamId = teamId;
  metaDATPluginOptions.metaAppId = process.env.META_WEARABLES_APP_ID;
}

module.exports = {
  expo: {
    name: 'Mantra',
    slug: 'agent-glasses',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    scheme: urlScheme,
    userInterfaceStyle: 'dark',
    newArchEnabled: false, // Disabled: RN 0.76.9 TurboModule void methods crash on NSException (RN #53960). Re-enable after upgrading to RN 0.83+.
    ios: iosConfig,
    plugins: [
      ['@sentry/react-native/expo', {
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        // Disable automatic source map upload during EAS builds —
        // SENTRY_AUTH_TOKEN is not available in the EAS build env.
        // Source maps can be uploaded separately via sentry-cli post-build.
        autoUpload: false,
      }],
      ['expo-contacts', { contactsPermission: 'Mantra uses contacts access to stage selected iOS contacts for review in People.' }],
      'expo-router',
      '@livekit/react-native-expo-plugin',
      '@config-plugins/react-native-webrtc',
      './plugins/withAgentAppIntents',
      ['./plugins/withMetaDAT', metaDATPluginOptions],
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: IOS_DEPLOYMENT_TARGET,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    owner: 'oniops2026',
    extra: {
      metaWearables: {
        developerMode,
        bundleIdentifier,
        universalLink: `https://${universalLinkHost}`,
        associatedDomainsEnabled: enableAssociatedDomains,
        associatedDomainsRequested,
        easBuildProfile,
        gitCommitSha,
      },
      eas: {
        projectId: '02064fed-cb68-4c61-9c56-a96ddaa570c8',
      },
    },
  },
};
