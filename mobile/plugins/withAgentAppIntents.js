const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const { addBuildSourceFileToGroup } = require('@expo/config-plugins/build/ios/utils/Xcodeproj');

const FILE_NAME = 'AgentAppIntents.swift';

const SWIFT_SOURCE = `import AppIntents
import Foundation
import UIKit

@available(iOS 16.0, *)
private enum AgentDeepLink {
  static func url(path: String, queryItems: [URLQueryItem] = []) throws -> URL {
    var components = URLComponents()
    components.scheme = "agentglasses"
    components.host = path
    components.queryItems = queryItems.isEmpty ? nil : queryItems

    guard let url = components.url else {
      throw AgentAppIntentError.invalidDeepLink
    }

    return url
  }
}

@available(iOS 16.0, *)
enum AgentAppIntentError: Error, CustomLocalizedStringResourceConvertible {
  case invalidDeepLink

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .invalidDeepLink:
      return "Mantra could not create the launch link."
    }
  }
}

@available(iOS 16.0, *)
struct StartAgentIntent: AppIntent {
  static var title: LocalizedStringResource = "Start Mantra"
  static var description = IntentDescription("Open Mantra and start a voice session through the active audio route.")
  static var openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    await UIApplication.shared.open(try AgentDeepLink.url(path: "start"))
    return .result()
  }
}

@available(iOS 16.0, *)
struct AskAgentIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Mantra"
  static var description = IntentDescription("Open Mantra, start voice, and pass a short question as launch context.")
  static var openAppWhenRun = true

  @Parameter(title: "Question", requestValueDialog: "What do you want to ask Mantra?")
  var question: String

  init() {
    self.question = ""
  }

  init(question: String) {
    self.question = question
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    await UIApplication.shared.open(try AgentDeepLink.url(
      path: "ask",
      queryItems: [URLQueryItem(name: "text", value: question)]
    ))
    return .result()
  }
}

@available(iOS 16.0, *)
struct WhatAmILookingAtIntent: AppIntent {
  static var title: LocalizedStringResource = "What am I looking at?"
  static var description = IntentDescription("Open Mantra and capture a foreground DAT quick-vision frame from the glasses.")
  static var openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    await UIApplication.shared.open(try AgentDeepLink.url(path: "vision", queryItems: [
      URLQueryItem(name: "mode", value: "quick")
    ]))
    return .result()
  }
}

@available(iOS 16.0, *)
struct StartLiveCoachIntent: AppIntent {
  static var title: LocalizedStringResource = "Start live coach"
  static var description = IntentDescription("Open Mantra and start the live coaching voice session.")
  static var openAppWhenRun = true

  @MainActor
  func perform() async throws -> some IntentResult {
    await UIApplication.shared.open(try AgentDeepLink.url(path: "coach", queryItems: [
      URLQueryItem(name: "mode", value: "live")
    ]))
    return .result()
  }
}

@available(iOS 16.0, *)
struct AgentAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartAgentIntent(),
      phrases: ["Start \\(.applicationName)"],
      shortTitle: "Start Mantra",
      systemImageName: "sparkles"
    )

    AppShortcut(
      intent: AskAgentIntent(),
      phrases: ["Ask \\(.applicationName)"],
      shortTitle: "Ask Mantra",
      systemImageName: "mic"
    )

    AppShortcut(
      intent: WhatAmILookingAtIntent(),
      phrases: ["What am I looking at with \\(.applicationName)"],
      shortTitle: "What am I looking at?",
      systemImageName: "camera.viewfinder"
    )

    AppShortcut(
      intent: StartLiveCoachIntent(),
      phrases: ["Start live coach with \\(.applicationName)"],
      shortTitle: "Start live coach",
      systemImageName: "figure.mind.and.body"
    )
  }
}
`;

function getIosProjectName(config) {
  return config.modRequest.projectName;
}

const withAgentAppIntents = (config) => {
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const projectName = getIosProjectName(config);
      const targetDir = path.join(config.modRequest.platformProjectRoot, projectName);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, FILE_NAME), SWIFT_SOURCE);
      return config;
    },
  ]);

  config = withXcodeProject(config, (config) => {
    const projectName = getIosProjectName(config);
    addBuildSourceFileToGroup({
      filepath: `${projectName}/${FILE_NAME}`,
      groupName: projectName,
      project: config.modResults,
      verbose: true,
    });
    return config;
  });

  return config;
};

module.exports = withAgentAppIntents;
