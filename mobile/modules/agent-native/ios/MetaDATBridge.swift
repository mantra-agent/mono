import Foundation
import UIKit

#if canImport(MWDATCore) && canImport(MWDATCamera)
import MWDATCore
import MWDATCamera
#endif

#if canImport(MWDATDisplay)
import MWDATDisplay
#endif

typealias MetaDATEventSink = ([String: Any]) -> Void

@MainActor
final class MetaDATBridge {
  static let shared = MetaDATBridge()

  private var eventSink: MetaDATEventSink?
  private var configured = false
  private var session: DeviceSession?
  private var stream: MWDATCamera.Stream?
  private var display: MWDATDisplay.Display?
  private var frameCount = 0

  private var registrationTask: Task<Void, Never>?
  private var deviceTask: Task<Void, Never>?
  private var sessionStateTask: Task<Void, Never>?
  private var streamStateToken: AnyListenerToken?
  private var videoFrameToken: AnyListenerToken?
  private var photoDataToken: AnyListenerToken?
  private var displayStateToken: AnyListenerToken?
  private var photoContinuation: CheckedContinuation<[String: Any], Error>?

  private init() {}

  func setEventSink(_ sink: MetaDATEventSink?) { eventSink = sink }

  // MARK: - Configure

  func configure() async -> [String: Any] {
    if configured { return ["configured": true, "timestamp": ts()] }
    do {
      try Wearables.configure()
      configured = true
      let w = Wearables.shared
      observeRegistration(w)
      observeDevices(w)
      return ["configured": true, "deviceCount": w.devices.count, "timestamp": ts()]
    } catch {
      return err("configureFailed", error)
    }
  }

  // MARK: - Registration

  func startRegistration() async -> [String: Any] {
    _ = await configure()
    do {
      try await Wearables.shared.startRegistration()
      emit("registrationStarted")
      return ["started": true, "timestamp": ts()]
    } catch {
      return err("registrationFailed", error)
    }
  }

  func handleUrl(_ urlString: String) async -> [String: Any] {
    guard let url = URL(string: urlString) else {
      return ["handled": false, "error": "Invalid URL", "timestamp": ts()]
    }
    _ = await configure()
    do {
      _ = try await Wearables.shared.handleUrl(url)
      return ["handled": true, "timestamp": ts()]
    } catch {
      return ["handled": false, "error": desc(error), "timestamp": ts()]
    }
  }

  // MARK: - Camera Permission

  func checkCameraPermission() async -> [String: Any] {
    _ = await configure()
    do {
      let status = try await Wearables.shared.checkPermissionStatus(.camera)
      let statusStr = desc(status)
      return [
        "status": statusStr,
        "granted": statusStr.contains("granted"),
        "timestamp": ts()
      ]
    } catch {
      return err("checkCameraPermissionFailed", error)
    }
  }

  func requestCameraPermission() async -> [String: Any] {
    _ = await configure()
    // Check current status first
    do {
      let currentStatus = try await Wearables.shared.checkPermissionStatus(.camera)
      let currentDesc = desc(currentStatus)
      if currentDesc.contains("granted") {
        return ["status": currentDesc, "granted": true, "alreadyGranted": true, "timestamp": ts()]
      }
    } catch {
      // If check fails, proceed to request anyway
    }
    // This opens Meta AI app for the user to grant camera permission
    // Wrap in a timeout since the call can hang if Meta AI fails to show the prompt
    let result = await withTaskGroup(of: Result<String, Error>.self) { group in
      group.addTask {
        do {
          try await Wearables.shared.requestPermission(.camera)
          let newStatus = try await Wearables.shared.checkPermissionStatus(.camera)
          return .success(String(describing: newStatus))
        } catch {
          return .failure(error)
        }
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        return .failure(BridgeError.rejected("Camera permission request timed out after 30s"))
      }
      let first = await group.next()!
      group.cancelAll()
      return first
    }
    switch result {
    case .success(let statusStr):
      let granted = statusStr.contains("granted")
      self.emit("cameraPermission", ["status": statusStr, "granted": granted])
      return ["status": statusStr, "granted": granted, "timestamp": ts()]
    case .failure(let error):
      return self.err("cameraPermissionFailed", error)
    }
  }

  // MARK: - Devices

  func listDevices() async -> [String: Any] {
    _ = await configure()
    let w = Wearables.shared
    let devices = w.devices.map { deviceInfo($0) }
    return [
      "devices": devices,
      "registrationState": desc(w.registrationState),
      "timestamp": ts()
    ]
  }

  // MARK: - Connect / Disconnect

  func connect(deviceId: String?) async -> [String: Any] {
    _ = await configure()
    let w = Wearables.shared
    do {
      let selector: any DeviceSelector
      if let id = deviceId, !id.isEmpty,
         let identifier = w.devices.first(where: { desc($0) == id }) {
        selector = SpecificDeviceSelector(device: identifier)
      } else {
        selector = AutoDeviceSelector(wearables: w)
      }

      let newSession = try w.createSession(deviceSelector: selector)
      session = newSession
      try newSession.start()
      observeSession(newSession)
      emit("connected", ["sessionState": desc(newSession.state)])

      // Wait for session to reach .started (the device controls this transition)
      let sessionState = await awaitSessionStarted(newSession, timeoutSeconds: 15)
      return [
        "connected": true,
        "sessionState": sessionState,
        "timestamp": ts()
      ]
    } catch {
      return err("connectFailed", error)
    }
  }

  func disconnect() async -> [String: Any] {
    await stopVideoStream()
    await stopDisplay()
    sessionStateTask?.cancel()
    sessionStateTask = nil
    session?.stop()
    session = nil
    emit("disconnected")
    return ["disconnected": true, "timestamp": ts()]
  }

  // MARK: - Session Lifecycle

  private func awaitSessionStarted(_ s: DeviceSession, timeoutSeconds: Int) async -> String {
    let currentState = desc(s.state)
    if currentState.contains("started") { return currentState }

    return await withTaskGroup(of: String.self) { group in
      group.addTask {
        for await state in s.stateStream() {
          let stateStr = String(describing: state)
          if stateStr.contains("started") || stateStr.contains("stopped") {
            return stateStr
          }
        }
        return "streamEnded"
      }

      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
        return "timeout(\(String(describing: s.state)))"
      }

      let result = await group.next() ?? "unknown"
      group.cancelAll()
      return result
    }
  }

  private func awaitStreamStreaming(_ s: MWDATCamera.Stream, timeoutSeconds: Int) async -> String {
    let currentState = desc(s.state)
    if currentState.contains("streaming") { return currentState }

    return await withTaskGroup(of: String.self) { group in
      group.addTask { @MainActor in
        await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
          var token: AnyListenerToken?
          var resumed = false
          token = s.statePublisher.listen { state in
            let stateStr = String(describing: state)
            if !resumed && (stateStr.contains("streaming") || stateStr.contains("stopped")) {
              resumed = true
              token = nil
              continuation.resume(returning: stateStr)
            }
          }
        }
      }

      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
        return "timeout(\(String(describing: s.state)))"
      }

      let result = await group.next() ?? "unknown"
      group.cancelAll()
      return result
    }
  }

  // MARK: - Camera

  func startVideoStream() async -> [String: Any] {
    guard let s = session else { return err("noSession", nil) }

    let sessionState = desc(s.state)
    if !sessionState.contains("started") {
      emit("waitingForSession", ["currentState": sessionState])
      let finalState = await awaitSessionStarted(s, timeoutSeconds: 15)
      if !finalState.contains("started") {
        return err("sessionNotStarted", BridgeError.rejected(
          "Session state is \(finalState), expected started. Cannot add stream."
        ))
      }
    }

    if stream != nil { return ["streaming": true, "timestamp": ts()] }
    do {
      let config = StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 24)
      guard let newStream = try s.addStream(config: config) else {
        return err("addStreamFailed", nil)
      }
      stream = newStream
      frameCount = 0
      setupStreamListeners(newStream)
      try await newStream.start()

      let streamState = await awaitStreamStreaming(newStream, timeoutSeconds: 10)
      emit("videoStreamStarted", ["streamState": streamState])
      if streamState.contains("stopped") {
        return err("streamStopped", BridgeError.rejected(
          "Stream transitioned to stopped instead of streaming"
        ))
      }
      return ["streaming": true, "streamState": streamState, "timestamp": ts()]
    } catch {
      return err("videoStreamFailed", error)
    }
  }

  @discardableResult
  func stopVideoStream() async -> [String: Any] {
    guard let s = stream else { return ["streaming": false, "timestamp": ts()] }
    clearStreamListeners()
    stream = nil
    await s.stop()
    emit("videoStreamStopped", ["frameCount": frameCount])
    return ["streaming": false, "frameCount": frameCount, "timestamp": ts()]
  }

  func capturePhoto() async -> [String: Any] {
    emit("capturePhotoRequested")
    if stream == nil {
      emit("capturePhotoStartingStream")
      let streamResult = await startVideoStream()
      emit("capturePhotoStartStreamResult", streamResult)
      if streamResult["error"] != nil {
        var result = streamResult
        result["errorType"] = streamResult["errorType"] ?? "startStreamFailed"
        result["capturePhase"] = "startVideoStream"
        return result
      }
    }
    guard let s = stream else { return err("noStreamAfterStart", nil) }

    let streamState = desc(s.state)
    emit("capturePhotoStreamState", ["state": streamState])
    if !streamState.contains("streaming") {
      return err("streamNotReady", BridgeError.rejected(
        "Stream state is \(streamState), expected streaming. Cannot capture."
      ))
    }

    do {
      return try await withCheckedThrowingContinuation { continuation in
        photoContinuation = continuation
        emit("capturePhotoCallingDAT")
        let accepted = s.capturePhoto(format: .jpeg)
        emit("capturePhotoAccepted", ["accepted": accepted])
        if !accepted {
          photoContinuation = nil
          continuation.resume(throwing: BridgeError.rejected("Photo capture rejected"))
          return
        }

        Task { [weak self] in
          try? await Task.sleep(nanoseconds: 30_000_000_000)
          guard let self = self else { return }
          if self.photoContinuation != nil {
            self.emit("capturePhotoTimedOutWaitingForData")
            self.photoContinuation = nil
            continuation.resume(throwing: BridgeError.rejected("Photo capture timed out waiting for DAT photo data"))
          }
        }
      }
    } catch {
      return err("capturePhotoFailed", error)
    }
  }

  // MARK: - Display

  func sendDisplay(content: [String: Any]) async -> [String: Any] {
    guard let s = session else { return err("noSession", nil) }

    do {
      if display == nil {
        let d = try s.addDisplay()
        display = d
        try await d.start()
      }
      guard let d = display else { return err("displayInitFailed", nil) }

      let view = buildDisplayView(from: content)
      try await d.send(view)
      emit("displaySent")
      return ["sent": true, "timestamp": ts()]
    } catch {
      return err("displayFailed", error)
    }
  }

  @discardableResult
  private func stopDisplay() async -> [String: Any] {
    displayStateToken = nil
    display = nil
    return ["displayStopped": true, "timestamp": ts()]
  }

  // MARK: - Display View Builder

  private func buildDisplayView(from content: [String: Any]) -> MWDATDisplay.FlexBox {
    let type = content["type"] as? String ?? "text"
    let padding = CGFloat(content["padding"] as? Int ?? 24)

    switch type {
    case "flexbox":
      let children = content["children"] as? [[String: Any]] ?? []
      let heading = children.first(where: { ($0["style"] as? String) == "heading" })?["text"] as? String
      let body = children.first(where: { ($0["style"] as? String) != "heading" })?["text"] as? String
        ?? children.first?["text"] as? String

      if let heading, let body {
        return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(heading, style: .heading)
          MWDATDisplay.Text(body, style: .body)
        }.padding(padding)
      } else if let heading {
        return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(heading, style: .heading)
        }.padding(padding)
      } else {
        return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(body ?? "", style: .body)
        }.padding(padding)
      }

    case "button":
      let label = content["label"] as? String ?? "OK"
      return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
        MWDATDisplay.Button(label: label, style: .primary) {}
      }.padding(padding)

    default:
      let text = content["text"] as? String ?? content["message"] as? String ?? ""
      let styleName = content["style"] as? String ?? "body"
      if styleName == "heading" {
        return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(text, style: .heading)
        }.padding(padding)
      } else {
        return MWDATDisplay.FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(text, style: .body)
        }.padding(padding)
      }
    }
  }

  // MARK: - Auto Setup

  /// Attempts full DAT setup: configure → register → permission → connect.
  /// Each step is best-effort; failures are logged but don't block the app.
  func autoSetup() async -> [String: Any] {
    var log: [[String: Any]] = []

    // 1. Configure
    let configResult = await configure()
    log.append(["step": "configure", "result": configResult])
    if configResult["error"] != nil { return ["autoSetup": false, "log": log, "stoppedAt": "configure"] }

    // 2. Check registration
    let w = Wearables.shared
    let regState = desc(w.registrationState)
    log.append(["step": "registrationCheck", "state": regState])

    if !regState.contains("registered") {
      // Not registered — can't auto-register (requires user interaction with Meta AI)
      return ["autoSetup": false, "log": log, "stoppedAt": "notRegistered", "registrationState": regState]
    }

    // 3. Check camera permission
    let permResult = await checkCameraPermission()
    log.append(["step": "cameraPermission", "result": permResult])
    let hasCamera = (permResult["granted"] as? Bool) == true

    // 4. Find devices
    let devicesResult = await listDevices()
    log.append(["step": "listDevices", "result": devicesResult])
    guard let devices = devicesResult["devices"] as? [[String: Any]], !devices.isEmpty else {
      return ["autoSetup": false, "log": log, "stoppedAt": "noDevices"]
    }

    // 5. Connect to first device
    let firstDeviceId = devices.first?["id"] as? String
    let connectResult = await connect(deviceId: firstDeviceId)
    log.append(["step": "connect", "result": connectResult])
    let sessionState = connectResult["sessionState"] as? String ?? ""

    if !sessionState.contains("started") {
      return ["autoSetup": false, "log": log, "stoppedAt": "sessionNotStarted", "sessionState": sessionState]
    }

    return [
      "autoSetup": true,
      "log": log,
      "connected": true,
      "sessionState": sessionState,
      "cameraPermission": hasCamera
    ]
  }

  // MARK: - Observers

  private func observeRegistration(_ w: WearablesInterface) {
    registrationTask?.cancel()
    registrationTask = Task { [weak self] in
      for await state in w.registrationStateStream() {
        await self?.emit("registrationState", ["state": self?.desc(state) ?? "unknown"])
      }
    }
  }

  private func observeDevices(_ w: WearablesInterface) {
    deviceTask?.cancel()
    deviceTask = Task { [weak self] in
      for await devices in w.devicesStream() {
        await self?.emit("devicesChanged", ["count": devices.count])
      }
    }
  }

  private func observeSession(_ s: DeviceSession) {
    sessionStateTask?.cancel()
    sessionStateTask = Task { [weak self] in
      for await state in s.stateStream() {
        await self?.emit("sessionState", ["state": self?.desc(state) ?? "unknown"])
      }
    }
  }

  private func setupStreamListeners(_ s: MWDATCamera.Stream) {
    clearStreamListeners()
    streamStateToken = s.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.emit("streamState", ["state": self?.desc(state) ?? "unknown"]) }
    }
    videoFrameToken = s.videoFramePublisher.listen { [weak self] frame in
      Task { @MainActor in self?.handleFrame(frame) }
    }
    photoDataToken = s.photoDataPublisher.listen { [weak self] data in
      Task { @MainActor in self?.handlePhoto(data) }
    }
  }

  private func clearStreamListeners() {
    streamStateToken = nil
    videoFrameToken = nil
    photoDataToken = nil
    photoContinuation = nil
  }

  // MARK: - Frame / Photo Handlers

  private func handleFrame(_ frame: VideoFrame) {
    frameCount += 1
    guard frameCount == 1 || frameCount % 30 == 0 else { return }
    var meta: [String: Any] = ["frameCount": frameCount]
    if let img = frame.makeUIImage() {
      meta["width"] = Int(img.size.width)
      meta["height"] = Int(img.size.height)
    }
    emit("videoFrame", meta)
  }

  private func handlePhoto(_ data: PhotoData) {
    let base64 = data.data.base64EncodedString()
    let url = writePhoto(data.data)
    let result: [String: Any] = [
      "timestamp": ts(),
      "contentType": "image/jpeg",
      "byteCount": data.data.count,
      "fileUrl": url?.absoluteString as Any,
      "base64": base64
    ]
    let hadContinuation = photoContinuation != nil
    emit("photoDataReceived", ["byteCount": data.data.count, "base64Length": base64.count, "hasContinuation": hadContinuation])
    photoContinuation?.resume(returning: result)
    emit("photoContinuationResumed", ["hadContinuation": hadContinuation])
    photoContinuation = nil
  }

  private func writePhoto(_ data: Data) -> URL? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("dat-photo.jpg")
    try? data.write(to: url, options: .atomic)
    return url
  }

  // MARK: - Helpers

  private func deviceInfo(_ id: DeviceIdentifier) -> [String: Any] {
    var info: [String: Any] = ["id": desc(id)]
    if let device = Wearables.shared.deviceForIdentifier(id) {
      info["name"] = device.nameOrId()
      info["type"] = desc(device.deviceType())
      info["supportsDisplay"] = device.supportsDisplay()
    }
    return info
  }

  private func emit(_ type: String, _ metadata: [String: Any] = [:]) {
    var event: [String: Any] = ["type": type, "timestamp": ts()]
    for (k, v) in metadata { event[k] = v }
    eventSink?(event)
  }

  private func err(_ type: String, _ error: Error?) -> [String: Any] {
    let msg = error.map { desc($0) } ?? type
    emit(type, ["error": msg])
    return ["error": msg, "errorType": type, "timestamp": ts()]
  }

  private func ts() -> String { ISO8601DateFormatter().string(from: Date()) }
  private func desc<T>(_ v: T) -> String { String(describing: v) }
}

enum BridgeError: LocalizedError {
  case rejected(String)
  var errorDescription: String? {
    switch self { case .rejected(let m): return m }
  }
}
