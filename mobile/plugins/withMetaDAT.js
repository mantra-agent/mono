/**
 * withMetaDAT — Expo config plugin for Meta DAT (Device Access Toolkit) iOS integration.
 *
 * Handles all iOS build configuration for Meta Wearables:
 *   - Info.plist keys (MWDAT dict, background modes, Bluetooth, external accessory, URL schemes)
 *   - Associated domains for universal link callback
 *
 * The SPM dependency (MWDATCore, MWDATCamera, MWDATDisplay) is managed by the
 * AgentNative podspec via React Native's spm_dependency helper, NOT via project-level
 * Xcode SPM injection. This avoids the CocoaPods/SPM visibility boundary issue where
 * pod targets cannot see SPM packages linked only to the main app target.
 */

const {
  withInfoPlist,
  withEntitlementsPlist,
  withXcodeProject,
} = require('@expo/config-plugins');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge an array value into an Info.plist array key, avoiding duplicates */
function mergeArray(plist, key, values) {
  if (!plist[key]) plist[key] = [];
  for (const v of values) {
    if (!plist[key].includes(v)) {
      plist[key].push(v);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Info.plist configuration
// ---------------------------------------------------------------------------

function withMetaDATInfoPlist(config, props) {
  return withInfoPlist(config, (config) => {
    const plist = config.modResults;

    // MWDAT configuration dict
    const mwdat = {
      AppLinkURLScheme: `${props.urlScheme}://`,
      MetaAppID: props.metaAppId || '0',
    };
    if (props.clientToken) {
      mwdat.ClientToken = props.clientToken;
    }
    if (props.teamId) {
      mwdat.TeamID = props.teamId;
    }
    if (props.damEnabled) {
      mwdat.DAMEnabled = true;
    }
    plist.MWDAT = mwdat;

    // Bluetooth
    if (!plist.NSBluetoothAlwaysUsageDescription) {
      plist.NSBluetoothAlwaysUsageDescription =
        'Agent needs Bluetooth access to connect to Meta Wearables.';
    }

    // Background modes
    mergeArray(plist, 'UIBackgroundModes', [
      'bluetooth-peripheral',
      'external-accessory',
    ]);

    // External accessory protocol
    mergeArray(plist, 'UISupportedExternalAccessoryProtocols', [
      'com.meta.ar.wearable',
    ]);

    // Query schemes (for opening Meta AI app)
    mergeArray(plist, 'LSApplicationQueriesSchemes', ['fb-viewapp']);

    // URL scheme for DAT callback
    const existingUrlTypes = plist.CFBundleURLTypes || [];
    const hasScheme = existingUrlTypes.some(
      (t) => t.CFBundleURLSchemes && t.CFBundleURLSchemes.includes(props.urlScheme)
    );
    if (!hasScheme) {
      existingUrlTypes.push({
        CFBundleURLName: props.bundleIdentifier,
        CFBundleURLSchemes: [props.urlScheme],
      });
      plist.CFBundleURLTypes = existingUrlTypes;
    }

    return config;
  });
}

// ---------------------------------------------------------------------------
// 2. Associated domains entitlement
// ---------------------------------------------------------------------------

function withMetaDATAssociatedDomains(config, props) {
  if (!props.enableAssociatedDomains || !props.universalLinkHost) {
    return config;
  }

  return withEntitlementsPlist(config, (config) => {
    const entitlements = config.modResults;
    const domain = `applinks:${props.universalLinkHost}`;
    if (!entitlements['com.apple.developer.associated-domains']) {
      entitlements['com.apple.developer.associated-domains'] = [];
    }
    const domains = entitlements['com.apple.developer.associated-domains'];
    if (!domains.includes(domain)) {
      domains.push(domain);
    }
    return config;
  });
}

// Frameworks that need embedding. MWDATDisplay is v0.7+ only.
var EMBED_FRAMEWORKS = ['MWDATCore', 'MWDATCamera', 'MWDATDisplay'];

// ---------------------------------------------------------------------------
// 3. Xcode build phases: embed frameworks + remove duplicate signatures
//
// spm_dependency in the podspec links the SDK at compile time, but CocoaPods
// doesn't embed dynamic frameworks into the app bundle. We add two build phases:
//
// a) "Embed MWDAT Frameworks" -- copies built frameworks into .app/Frameworks/
//    and codesigns them. Mirrors expo-meta-wearables-dat (community wrapper).
//
// b) "Remove duplicate DAT xcframework signatures" -- cleans up stale .signature
//    files that cause "item with the same name already exists" archive errors.
//    See: https://github.com/maplibre/maplibre-react-native/issues/237
// ---------------------------------------------------------------------------

function withMetaDATBuildPhases(config) {
  return withXcodeProject(config, function(config) {
    var xcodeProject = config.modResults;

    // --- Embed frameworks build phase ---
    // Copy from BUILT_PRODUCTS_DIR into the app Frameworks folder, then codesign.
    var frameworkNames = EMBED_FRAMEWORKS.map(function(fw) { return '"' + fw + '"'; }).join(' ');
    var embedLines = [
      'FRAMEWORKS=(' + frameworkNames + ')',
      'for fw in "${FRAMEWORKS[@]}"; do',
      '  SRC="${BUILT_PRODUCTS_DIR}/${fw}.framework"',
      '  DST="${BUILT_PRODUCTS_DIR}/${FRAMEWORKS_FOLDER_PATH}/${fw}.framework"',
      '  if [ -d "${SRC}" ]; then',
      '    if [ ! -d "${DST}" ]; then',
      '      mkdir -p "$(dirname "${DST}")"',
      '      cp -R "${SRC}" "${DST}"',
      '      codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --preserve-metadata=identifier,entitlements "${DST}"',
      '    fi',
      '  fi',
      'done',
    ];

    xcodeProject.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      'Embed MWDAT Frameworks',
      null,
      {
        shellPath: '/bin/sh',
        shellScript: embedLines.join('\n'),
        inputPaths: EMBED_FRAMEWORKS.map(function(fw) {
          return '"${BUILT_PRODUCTS_DIR}/' + fw + '.framework"';
        }),
        outputPaths: EMBED_FRAMEWORKS.map(function(fw) {
          return '"${BUILT_PRODUCTS_DIR}/${FRAMEWORKS_FOLDER_PATH}/' + fw + '.framework"';
        }),
      }
    );

    // --- Remove duplicate signatures build phase ---
    var sigLines = ['echo "Removing duplicate xcframework signatures (CocoaPods + SPM workaround)"'];
    for (var i = 0; i < EMBED_FRAMEWORKS.length; i++) {
      var fw = EMBED_FRAMEWORKS[i];
      sigLines.push('rm -rf "$BUILD_DIR/Release-iphoneos/' + fw + '.xcframework-ios.signature"');
      sigLines.push('rm -rf "$BUILD_DIR/Debug-iphoneos/' + fw + '.xcframework-ios.signature"');
    }

    xcodeProject.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      'Remove duplicate DAT xcframework signatures',
      null,
      {
        shellPath: '/bin/sh',
        shellScript: sigLines.join('\n'),
      }
    );

    return config;
  });
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

function withMetaDAT(config, props) {
  props = props || {};
  var defaults = {
    urlScheme: 'agentglasses',
    bundleIdentifier: 'com.oniops.firstglasses',
    universalLinkHost: 'raymondkallmeyer.com',
    metaAppId: '0',
    clientToken: undefined,
    teamId: undefined,
    damEnabled: true,
    enableAssociatedDomains: false,
    sdkVersion: '0.7.0',
  };

  var merged = Object.assign({}, defaults, props);

  config = withMetaDATInfoPlist(config, merged);
  config = withMetaDATAssociatedDomains(config, merged);
  config = withMetaDATBuildPhases(config);

  return config;
}

module.exports = withMetaDAT;
