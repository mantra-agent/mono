import AVFoundation
import ExpoModulesCore
import UIKit

public class AgentNativeModule: Module {
  private var observersInstalled = false
  private var routeEvents: [[String: Any]] = []
  private var recorder: AVAudioRecorder?
  private var player: AVAudioPlayer?
  private var lastSampleUrl: URL?

  public func definition() -> ModuleDefinition {
    Name("AgentNative")

    Events("onMetaDATEvent")

    OnStartObserving {
      Task { @MainActor [weak self] in
        MetaDATBridge.shared.setEventSink { [weak self] event in
          self?.sendEvent("onMetaDATEvent", event)
        }
      }
    }

    OnStopObserving {
      Task { @MainActor in
        MetaDATBridge.shared.setEventSink(nil)
      }
    }

    // MARK: - Environment

    AsyncFunction("getNativeEnvironment") { () -> [String: Any] in
      return self.nativeEnvironment()
    }

    // MARK: - Audio Route

    // Read-only: installs observers and returns diagnostics WITHOUT configuring
    // the audio session. This prevents conflicts with WebRTC/LiveKit which
    // needs exclusive AVAudioSession ownership on iOS 26+.
    AsyncFunction("startAudioRouteObservers") { () -> [String: Any] in
      self.installAudioObservers()
      return self.audioRouteDiagnostics()
    }

    AsyncFunction("getAudioRouteDiagnostics") { () -> [String: Any] in
      self.installAudioObservers()
      return self.audioRouteDiagnostics()
    }

    AsyncFunction("selectHfpInput") { () -> [String: Any] in
      self.installAudioObservers()
      let session = AVAudioSession.sharedInstance()
      let candidate = self.hfpCandidate()

      // Set preferred input without reconfiguring category/mode.
      // WebRTC will set .playAndRecord + .videoChat when it connects.
      // We just tell iOS which input to prefer.
      if let input = candidate {
        try session.setPreferredInput(input)
        return [
          "selected": true,
          "fallback": "none",
          "selectedInput": self.portDescription(input),
          "diagnostics": self.audioRouteDiagnostics()
        ]
      }

      try session.setPreferredInput(nil)
      return [
        "selected": false,
        "fallback": "phoneMic",
        "diagnostics": self.audioRouteDiagnostics()
      ]
    }

    AsyncFunction("recordTenSecondSample") { () async throws -> [String: Any] in
      self.installAudioObservers()
      try self.configureForLocalAudio()
      try await self.ensureRecordPermission()

      let startedAt = self.timestamp()
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("agent-hfp-sample.m4a")

      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }

      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 16000.0,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
      ]

      let recorder = try AVAudioRecorder(url: url, settings: settings)
      recorder.prepareToRecord()
      recorder.record(forDuration: 10.0)
      self.recorder = recorder

      try await Task.sleep(nanoseconds: 10_250_000_000)
      recorder.stop()
      self.lastSampleUrl = url

      return [
        "fileUrl": url.absoluteString,
        "durationSeconds": 10,
        "startedAt": startedAt,
        "finishedAt": self.timestamp(),
        "diagnostics": self.audioRouteDiagnostics()
      ]
    }

    AsyncFunction("playBase64Audio") { (audioBase64: String, fileExtension: String?) -> [String: Any] in
      guard let data = Data(base64Encoded: audioBase64) else {
        throw NSError(domain: "AgentNative", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid base64 audio data."])
      }
      let safeExtension = fileExtension?.isEmpty == false ? fileExtension! : "mp3"
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("agent-answer")
        .appendingPathExtension(safeExtension)
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
      try data.write(to: url, options: .atomic)
      try self.configureForLocalAudio()
      try self.playAudioFile(url: url)
      return [
        "played": true,
        "source": "file",
        "fileUrl": url.absoluteString,
        "durationSeconds": self.player?.duration ?? 0
      ]
    }

    AsyncFunction("playAudioFileUrl") { (fileUrl: String) -> [String: Any] in
      guard let url = URL(string: fileUrl) else {
        throw NSError(domain: "AgentNative", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid audio file URL."])
      }
      try self.configureForLocalAudio()
      try self.playAudioFile(url: url)
      return [
        "played": true,
        "source": "file",
        "fileUrl": url.absoluteString
      ]
    }

    AsyncFunction("playLastSample") { () -> [String: Any] in
      guard let url = self.lastSampleUrl else {
        throw NSError(domain: "AgentNative", code: 404, userInfo: [NSLocalizedDescriptionKey: "No recorded sample is available yet."])
      }

      try self.configureForLocalAudio()
      try self.playAudioFile(url: url)
      return [
        "played": true,
        "source": "sample",
        "fileUrl": url.absoluteString
      ]
    }

    AsyncFunction("playTestTone") { () -> [String: Any] in
      try self.configureForLocalAudio()
      let url = try self.writeToneFile(frequency: 880.0, duration: 1.5)
      try self.playAudioFile(url: url)
      return [
        "played": true,
        "source": "tone",
        "fileUrl": url.absoluteString,
        "frequencyHz": 880,
        "durationSeconds": 1.5
      ]
    }

    AsyncFunction("copyRouteEvidence") { (evidence: String) -> [String: Any] in
      UIPasteboard.general.string = evidence
      return ["copied": true]
    }

    // MARK: - Meta DAT

    AsyncFunction("configureDat") { () async -> [String: Any] in
      await MetaDATBridge.shared.configure()
    }

    AsyncFunction("startDatRegistration") { () async -> [String: Any] in
      await MetaDATBridge.shared.startRegistration()
    }

    AsyncFunction("handleDatUrl") { (urlString: String) async -> [String: Any] in
      await MetaDATBridge.shared.handleUrl(urlString)
    }

    AsyncFunction("checkDatCameraPermission") { () async -> [String: Any] in
      await MetaDATBridge.shared.checkCameraPermission()
    }

    AsyncFunction("requestDatCameraPermission") { () async -> [String: Any] in
      await MetaDATBridge.shared.requestCameraPermission()
    }

    AsyncFunction("autoSetupDat") { () async -> [String: Any] in
      await MetaDATBridge.shared.autoSetup()
    }

    AsyncFunction("listDatDevices") { () async -> [String: Any] in
      await MetaDATBridge.shared.listDevices()
    }

    AsyncFunction("connectDatDevice") { (deviceId: String?) async -> [String: Any] in
      await MetaDATBridge.shared.connect(deviceId: deviceId)
    }

    AsyncFunction("disconnectDat") { () async -> [String: Any] in
      await MetaDATBridge.shared.disconnect()
    }

    AsyncFunction("startDatVideoStream") { () async -> [String: Any] in
      await MetaDATBridge.shared.startVideoStream()
    }

    AsyncFunction("stopDatVideoStream") { () async -> [String: Any] in
      await MetaDATBridge.shared.stopVideoStream()
    }

    AsyncFunction("captureDatPhoto") { () async -> [String: Any] in
      await MetaDATBridge.shared.capturePhoto()
    }

    AsyncFunction("sendDatDisplay") { (content: [String: Any]) async -> [String: Any] in
      await MetaDATBridge.shared.sendDisplay(content: content)
    }
  }

  // MARK: - Private Helpers (Audio)

  private func nativeEnvironment() -> [String: Any] {
    let bundle = Bundle.main
    let info = bundle.infoDictionary ?? [:]
    var environment: [String: Any] = [
      "platform": "ios",
      "moduleLoaded": true,
      "timestamp": timestamp()
    ]
    if let appName = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String {
      environment["appName"] = appName
    }
    if let bundleIdentifier = bundle.bundleIdentifier {
      environment["bundleIdentifier"] = bundleIdentifier
    }
    if let appVersion = info["CFBundleShortVersionString"] as? String {
      environment["appVersion"] = appVersion
    }
    if let buildNumber = info["CFBundleVersion"] as? String {
      environment["buildNumber"] = buildNumber
    }
    return environment
  }

  /// Configure audio session for LOCAL playback/recording only (diagnostic
  /// samples, test tones, base64 audio playback). This should NOT be called
  /// before WebRTC/LiveKit voice sessions — WebRTC needs exclusive ownership
  /// of AVAudioSession and will configure .playAndRecord + .videoChat itself.
  /// On iOS 26+, changing category/mode while another framework has the
  /// session active throws NSExceptions that crash via TurboModule bridge.
  private func configureForLocalAudio() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.allowBluetooth, .defaultToSpeaker]
    )
    try session.setPreferredSampleRate(16000.0)
    try session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)
  }

  private func installAudioObservers() {
    guard !observersInstalled else { return }
    observersInstalled = true

    NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { notification in
      let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      let reason = reasonValue.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
      self.appendRouteEvent(type: "routeChange", reason: self.routeChangeReasonName(reason), phase: nil)
    }

    NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { notification in
      let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      let type = typeValue.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
      self.appendRouteEvent(type: "interruption", reason: nil, phase: self.interruptionTypeName(type))
    }
  }

  private func appendRouteEvent(type: String, reason: String?, phase: String?) {
    var event: [String: Any] = [
      "type": type,
      "timestamp": timestamp(),
      "route": currentRouteDescription()
    ]
    if let reason { event["reason"] = reason }
    if let phase { event["phase"] = phase }
    routeEvents.append(event)
    if routeEvents.count > 20 { routeEvents.removeFirst(routeEvents.count - 20) }
  }

  private func audioRouteDiagnostics() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let currentInputs = session.currentRoute.inputs.map(portDescription)
    let currentOutputs = session.currentRoute.outputs.map(portDescription)
    let availableInputs = (session.availableInputs ?? []).map(portDescription)
    let candidate = hfpCandidate()
    let selectedUid = session.currentRoute.inputs.first?.uid
    var diagnostics: [String: Any] = [
      "timestamp": timestamp(),
      "category": session.category.rawValue,
      "mode": session.mode.rawValue,
      "categoryOptions": categoryOptionNames(session.categoryOptions),
      "sampleRate": session.sampleRate,
      "ioBufferDuration": session.ioBufferDuration,
      "currentInputs": currentInputs,
      "currentOutputs": currentOutputs,
      "availableInputs": availableInputs,
      "phoneMicFallbackExplicit": candidate == nil,
      "observersActive": observersInstalled,
      "recentEvents": routeEvents
    ]
    if let preferredInput = session.preferredInput {
      diagnostics["preferredInput"] = portDescription(preferredInput)
    }
    if let candidate {
      var hfp = portDescription(candidate)
      hfp["isSelected"] = candidate.uid == selectedUid
      diagnostics["hfpCandidate"] = hfp
    }
    return diagnostics
  }

  private func hfpCandidate() -> AVAudioSessionPortDescription? {
    (AVAudioSession.sharedInstance().availableInputs ?? []).first { $0.portType == .bluetoothHFP }
  }

  private func currentRouteDescription() -> [String: Any] {
    let route = AVAudioSession.sharedInstance().currentRoute
    return [
      "inputs": route.inputs.map(portDescription),
      "outputs": route.outputs.map(portDescription)
    ]
  }

  private func portDescription(_ port: AVAudioSessionPortDescription) -> [String: Any] {
    var d: [String: Any] = [
      "uid": port.uid,
      "name": port.portName,
      "portType": port.portType.rawValue
    ]
    if let channels = port.channels { d["channels"] = channels.count }
    if let dataSources = port.dataSources, !dataSources.isEmpty {
      d["dataSources"] = dataSources.map { $0.dataSourceName }
    }
    if let selectedDataSource = port.selectedDataSource {
      d["selectedDataSource"] = selectedDataSource.dataSourceName
    }
    return d
  }

  private func categoryOptionNames(_ options: AVAudioSession.CategoryOptions) -> [String] {
    var names: [String] = []
    if options.contains(.allowBluetooth) { names.append("allowBluetooth") }
    if #available(iOS 10.0, *), options.contains(.allowBluetoothA2DP) { names.append("allowBluetoothA2DP") }
    if options.contains(.defaultToSpeaker) { names.append("defaultToSpeaker") }
    if options.contains(.mixWithOthers) { names.append("mixWithOthers") }
    if options.contains(.duckOthers) { names.append("duckOthers") }
    if options.contains(.allowAirPlay) { names.append("allowAirPlay") }
    return names
  }

  private func routeChangeReasonName(_ reason: AVAudioSession.RouteChangeReason?) -> String {
    switch reason {
    case .newDeviceAvailable: return "newDeviceAvailable"
    case .oldDeviceUnavailable: return "oldDeviceUnavailable"
    case .categoryChange: return "categoryChange"
    case .override: return "override"
    case .wakeFromSleep: return "wakeFromSleep"
    case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
    case .routeConfigurationChange: return "routeConfigurationChange"
    case .unknown: return "unknown"
    case .none: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private func interruptionTypeName(_ type: AVAudioSession.InterruptionType?) -> String {
    switch type {
    case .began: return "began"
    case .ended: return "ended"
    case .none: return "unknown"
    @unknown default: return "unknown"
    }
  }

  private func ensureRecordPermission() async throws {
    let granted: Bool
    if #available(iOS 17.0, *) {
      granted = await withCheckedContinuation { continuation in
        AVAudioApplication.requestRecordPermission { allowed in
          continuation.resume(returning: allowed)
        }
      }
    } else {
      let session = AVAudioSession.sharedInstance()
      granted = await withCheckedContinuation { continuation in
        session.requestRecordPermission { allowed in
          continuation.resume(returning: allowed)
        }
      }
    }
    if !granted {
      throw NSError(domain: "AgentNative", code: 403, userInfo: [NSLocalizedDescriptionKey: "Microphone permission was denied."])
    }
  }

  private func playAudioFile(url: URL) throws {
    let player = try AVAudioPlayer(contentsOf: url)
    player.prepareToPlay()
    player.play()
    self.player = player
  }

  private func writeToneFile(frequency: Double, duration: Double) throws -> URL {
    let sampleRate = 44100
    let frameCount = Int(duration * Double(sampleRate))
    var pcm = Data()
    for frame in 0..<frameCount {
      let time = Double(frame) / Double(sampleRate)
      let amplitude = sin(2.0 * Double.pi * frequency * time) * 0.25
      var sample = Int16(amplitude * Double(Int16.max)).littleEndian
      pcm.append(Data(bytes: &sample, count: MemoryLayout<Int16>.size))
    }
    let byteRate = sampleRate * 2
    let blockAlign = 2
    var wav = Data()
    wav.append("RIFF".data(using: .ascii)!)
    wav.append(littleEndianUInt32(UInt32(36 + pcm.count)))
    wav.append("WAVEfmt ".data(using: .ascii)!)
    wav.append(littleEndianUInt32(16))
    wav.append(littleEndianUInt16(1))
    wav.append(littleEndianUInt16(1))
    wav.append(littleEndianUInt32(UInt32(sampleRate)))
    wav.append(littleEndianUInt32(UInt32(byteRate)))
    wav.append(littleEndianUInt16(UInt16(blockAlign)))
    wav.append(littleEndianUInt16(16))
    wav.append("data".data(using: .ascii)!)
    wav.append(littleEndianUInt32(UInt32(pcm.count)))
    wav.append(pcm)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("agent-test-tone.wav")
    try wav.write(to: url, options: .atomic)
    return url
  }

  private func littleEndianUInt16(_ value: UInt16) -> Data {
    var copy = value.littleEndian
    return Data(bytes: &copy, count: MemoryLayout<UInt16>.size)
  }

  private func littleEndianUInt32(_ value: UInt32) -> Data {
    var copy = value.littleEndian
    return Data(bytes: &copy, count: MemoryLayout<UInt32>.size)
  }

  private func timestamp() -> String {
    ISO8601DateFormatter().string(from: Date())
  }
}
