const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest;
const elevenLabsReactNativeEntry = path.resolve(
  projectRoot,
  'node_modules/@elevenlabs/react-native/dist/index.react-native.js',
);
const webStreamsPolyfillEntry = path.resolve(
  projectRoot,
  'node_modules/web-streams-polyfill/dist/ponyfill.js',
);
const elevenLabsReactEntry = path.resolve(
  projectRoot,
  'node_modules/@elevenlabs/react/dist/index.js',
);
const elevenLabsClientEntry = path.resolve(
  projectRoot,
  'node_modules/@elevenlabs/client/dist/index.js',
);
const elevenLabsClientInternalEntry = path.resolve(
  projectRoot,
  'node_modules/@elevenlabs/client/dist/internal.js',
);
const elevenLabsClientUnityEntry = path.resolve(
  projectRoot,
  'node_modules/@elevenlabs/client/dist/internal/unity.js',
);
const expoUpdatesStub = path.resolve(
  projectRoot,
  'src/stubs/expo-updates.js',
);

config.watchFolders = [path.resolve(workspaceRoot, 'shared')];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@shared': path.resolve(workspaceRoot, 'shared'),
};

// Expo/Metro package-exports resolution can choose the ElevenLabs browser/default
// entrypoint before the custom resolver gets a chance to force the React Native
// bundle. Keep package exports disabled for this app so SDK entrypoint selection
// is owned by the resolver below instead of upstream export-condition ordering.
config.resolver.unstable_enablePackageExports = false;

const elevenLabsReactNativeModuleNames = new Set([
  '@elevenlabs/react-native',
  '@elevenlabs/react-native/dist/index',
  '@elevenlabs/react-native/dist/index.js',
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Stub expo-updates so @sentry/react-native's global-scope require
  // resolves instead of crashing with "Requiring unknown module undefined".
  if (moduleName === 'expo-updates') {
    return {
      type: 'sourceFile',
      filePath: expoUpdatesStub,
    };
  }

  if (elevenLabsReactNativeModuleNames.has(moduleName)) {
    return {
      type: 'sourceFile',
      filePath: elevenLabsReactNativeEntry,
    };
  }

  if (moduleName === '@elevenlabs/react') {
    return {
      type: 'sourceFile',
      filePath: elevenLabsReactEntry,
    };
  }

  if (moduleName === '@elevenlabs/client') {
    return {
      type: 'sourceFile',
      filePath: elevenLabsClientEntry,
    };
  }

  if (moduleName === '@elevenlabs/client/internal') {
    return {
      type: 'sourceFile',
      filePath: elevenLabsClientInternalEntry,
    };
  }

  if (moduleName === '@elevenlabs/client/internal/unity') {
    return {
      type: 'sourceFile',
      filePath: elevenLabsClientUnityEntry,
    };
  }

  if (moduleName === 'web-streams-polyfill') {
    return {
      type: 'sourceFile',
      filePath: webStreamsPolyfillEntry,
    };
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
