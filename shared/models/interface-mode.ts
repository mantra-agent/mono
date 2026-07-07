export const interfaceModes = [
  "web_detail",
  "mobile_detail",
  "mobile_simple",
  "glasses_simple",
] as const;

export type InterfaceMode = typeof interfaceModes[number];

export const interfaceModeLabels: Record<InterfaceMode, string> = {
  web_detail: "Desktop",
  mobile_detail: "Phone",
  mobile_simple: "Simple",
  glasses_simple: "Glasses",
};

export const runtimeSurfaces = [
  "desktop_web",
  "mobile_web",
  "ios_native",
  "glasses_runtime",
] as const;

export type RuntimeSurface = typeof runtimeSurfaces[number];

export type RuntimeCapabilities = {
  microphone: boolean;
  camera: boolean;
  bluetooth: boolean;
  raybands: boolean;
  notifications: boolean;
  backgroundAudio: boolean;
  nativeAudioRouting: boolean;
  datCamera: boolean;
};

const allowedByRuntime: Record<RuntimeSurface, readonly InterfaceMode[]> = {
  desktop_web: interfaceModes,
  mobile_web: ["mobile_detail", "mobile_simple"],
  ios_native: ["mobile_detail", "mobile_simple"],
  glasses_runtime: ["glasses_simple"],
};

const defaultsByRuntime: Record<RuntimeSurface, InterfaceMode> = {
  desktop_web: "web_detail",
  mobile_web: "mobile_simple",
  ios_native: "mobile_simple",
  glasses_runtime: "glasses_simple",
};

export function isInterfaceMode(value: unknown): value is InterfaceMode {
  return typeof value === "string" && (interfaceModes as readonly string[]).includes(value);
}

export function getAllowedInterfaceModes(runtime: RuntimeSurface): readonly InterfaceMode[] {
  return allowedByRuntime[runtime];
}

export function getDefaultInterfaceMode(runtime: RuntimeSurface): InterfaceMode {
  return defaultsByRuntime[runtime];
}

export function isInterfaceModeAllowed(mode: InterfaceMode, runtime: RuntimeSurface): boolean {
  return getAllowedInterfaceModes(runtime).includes(mode);
}

export function resolveInterfaceMode(value: unknown, runtime: RuntimeSurface): InterfaceMode {
  if (isInterfaceMode(value) && isInterfaceModeAllowed(value, runtime)) return value;
  return getDefaultInterfaceMode(runtime);
}
