const telemetry = require('./src/lib/startup-telemetry');

telemetry.installGlobalErrorHandlers();
telemetry.markStartupPhase('process_start');
telemetry.markStartupPhase('polyfills_start');

require('./src/polyfills/dom-exception');
require('./src/polyfills/web-streams');

// Browser globals polyfill — livekit-client (via @elevenlabs/react-native)
// reaches for document, HTMLAudioElement, AudioContext, window.addEventListener,
// navigator.mediaDevices.addEventListener, etc. Without these stubs, the
// ReferenceErrors become NSExceptions on the TurboModule queue, causing SIGABRT.
// See: https://github.com/elevenlabs/packages/issues/766
require('./src/polyfills/browser-globals');

telemetry.markStartupPhase('polyfills_done');
telemetry.markStartupPhase('router_import_start');

require('./src/lib/sentry').initSentry();
require('expo-router/entry');
