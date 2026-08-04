export interface MemoryGraphSettings {
  linkAttractionFactor: number;
  linkBendFactor: number;
  nodeRepulsionFactor: number;
  pulseRate: number;
  pulseBrightness: number;
  pulseSize: number;
  linkComplexity: number;
  linkBrightnessFactor: number;
  nodeBrightnessFactor: number;
  recencyBrightness: number;
  smallestNode: number;
  largestNode: number;
}

export interface MemoryGraphSettingDefinition {
  key: keyof MemoryGraphSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  precision: number;
}

/**
 * Canonical, human-readable Memory Graph tuning defaults and ranges.
 * Persisted user settings are complete objects with these exact field names.
 */
export const MEMORY_GRAPH_SETTINGS_DEFAULTS: Readonly<MemoryGraphSettings> = {
  linkAttractionFactor: 3,
  linkBendFactor: 4.9,
  nodeRepulsionFactor: 2.3,
  pulseRate: 0.5,
  pulseBrightness: 0.75,
  pulseSize: 2,
  linkComplexity: 5,
  linkBrightnessFactor: 0.1,
  nodeBrightnessFactor: 2,
  recencyBrightness: 0.7,
  smallestNode: 4.5,
  largestNode: 54,
};

export const MEMORY_GRAPH_SETTING_DEFINITIONS: readonly MemoryGraphSettingDefinition[] = [
  { key: "linkAttractionFactor", label: "Link Attraction Factor", min: 0, max: 10, step: 0.05, precision: 2 },
  { key: "linkBendFactor", label: "Link Bend Factor", min: 0, max: 6, step: 0.05, precision: 2 },
  { key: "linkComplexity", label: "Link Complexity", min: 1, max: 12, step: 1, precision: 0 },
  { key: "linkBrightnessFactor", label: "Link Brightness Factor", min: 0.1, max: 10, step: 0.1, precision: 1 },
  { key: "nodeRepulsionFactor", label: "Node Repulsion Factor", min: 0, max: 10, step: 0.05, precision: 2 },
  { key: "nodeBrightnessFactor", label: "Node Brightness Factor", min: 0.1, max: 10, step: 0.1, precision: 1 },
  { key: "pulseRate", label: "Pulse Rate", min: 0.1, max: 20, step: 0.1, precision: 1 },
  { key: "pulseBrightness", label: "Pulse Brightness", min: 0, max: 2, step: 0.05, precision: 2 },
  { key: "pulseSize", label: "Pulse Size", min: 0.5, max: 5, step: 0.1, precision: 1 },
  { key: "recencyBrightness", label: "Recency Brightness", min: 0.22, max: 1, step: 0.01, precision: 2 },
  { key: "smallestNode", label: "Smallest Node", min: 0.5, max: 30, step: 0.5, precision: 1 },
  { key: "largestNode", label: "Largest Node", min: 5, max: 120, step: 1, precision: 0 },
] as const;

const DEFINITION_BY_KEY = new Map(
  MEMORY_GRAPH_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

function roundToStep(value: number, step: number): number {
  const precision = Math.max(0, (String(step).split(".")[1] ?? "").length);
  return Number((Math.round(value / step) * step).toFixed(precision));
}

export function normalizeMemoryGraphSettings(value: unknown): MemoryGraphSettings {
  const input = value && typeof value === "object"
    ? value as Partial<Record<keyof MemoryGraphSettings, unknown>>
    : {};
  const settings = { ...MEMORY_GRAPH_SETTINGS_DEFAULTS };

  for (const definition of MEMORY_GRAPH_SETTING_DEFINITIONS) {
    const candidate = input[definition.key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    settings[definition.key] = roundToStep(
      Math.min(definition.max, Math.max(definition.min, candidate)),
      definition.step,
    );
  }

  settings.smallestNode = Math.min(settings.smallestNode, settings.largestNode);
  settings.largestNode = Math.max(settings.largestNode, settings.smallestNode);
  return settings;
}

function hasValidMemoryGraphSettingValues(input: Record<string, unknown>): boolean {
  for (const key of Object.keys(input)) {
    const definition = DEFINITION_BY_KEY.get(key as keyof MemoryGraphSettings);
    const candidate = input[key];
    if (
      !definition
      || typeof candidate !== "number"
      || !Number.isFinite(candidate)
      || candidate < definition.min
      || candidate > definition.max
    ) return false;
  }
  return (input.smallestNode as number) <= (input.largestNode as number);
}

export function isCompleteMemoryGraphSettings(value: unknown): value is MemoryGraphSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === MEMORY_GRAPH_SETTING_DEFINITIONS.length
    && hasValidMemoryGraphSettingValues(input);
}

/** Accepts the immediately preceding complete snapshot during rolling client upgrades. */
export function isAcceptedMemoryGraphSettingsSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const isCurrent = keys.length === MEMORY_GRAPH_SETTING_DEFINITIONS.length;
  const isLegacyWithoutPulseSize = keys.length === MEMORY_GRAPH_SETTING_DEFINITIONS.length - 1
    && !("pulseSize" in input);
  return (isCurrent || isLegacyWithoutPulseSize) && hasValidMemoryGraphSettingValues(input);
}

export function formatMemoryGraphSettingValue(key: keyof MemoryGraphSettings, value: number): string {
  return value.toFixed(DEFINITION_BY_KEY.get(key)?.precision ?? 2);
}
