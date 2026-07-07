/**
 * Stub for expo-updates.
 *
 * @sentry/react-native's ExpoUpdatesListener integration does
 * `require('expo-updates')` at module load time (global scope in
 * spotlight.js → expoupdateslistener.js). Since expo-updates is not
 * installed, Metro compiles that to `require(undefined)` which throws
 * a fatal "Requiring unknown module" error on Hermes before any
 * try/catch can intercept it.
 *
 * This stub lets the require succeed, returning empty/safe values so
 * the integration discovers there's no update channel and becomes a
 * no-op.
 */
module.exports = {
  isEnabled: false,
  channel: null,
  updateId: null,
  runtimeVersion: null,
  checkForUpdateAsync: async () => ({ isAvailable: false }),
  fetchUpdateAsync: async () => ({ isNew: false }),
  useUpdates: () => ({
    isUpdateAvailable: false,
    isUpdatePending: false,
  }),
};
