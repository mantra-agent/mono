export interface MemoryGraphSettings {
  linkAttractionFactor: number;
  linkBendFactor: number;
  nodeRepulsionFactor: number;
  pulseRate: number;
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
  linkAttractionFactor: 1,
  linkBendFactor: 1,
  nodeRepulsionFactor: 1,
  pulseRate: 1,
  nodeBrightnessFactor: 2,
  recencyBrightness: 0.85,
  smallestNode: 4,
  largestNode: 40,
};

export const MEMORY_GRAPH_SETTING_DEFINITIONS: readonly MemoryGraphSettingDefinition[] = [
  { key: "linkAttractionFactor", label: "Link Attraction Factor", min: 0, max: 10, step: 0.05, precision: 2 },
  { key: "linkBendFactor", label: "Link Bend Factor", min: 0, max: 6, step: 0.05, precision: 2 },
  { key: "nodeRepulsionFactor", label: "Node Repulsion Factor", min: 0, max: 10, step: 0.05, precision: 2 },
  { key: "pulseRate", label: "Pulse Rate", min: 0.1, max: 20, step: 0.1, precision: 1 },
  { key: "nodeBrightnessFactor", label: "Node Brightness Factor", min: 0.1, max: 10, step: 0.1, precision: 1 },
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

export function isCompleteMemoryGraphSettings(value: unknown): value is MemoryGraphSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== MEMORY_GRAPH_SETTING_DEFINITIONS.length) return false;

  for (const definition of MEMORY_GRAPH_SETTING_DEFINITIONS) {
    const candidate = input[definition.key];
    if (
      typeof candidate !== "number"
      || !Number.isFinite(candidate)
      || candidate < definition.min
      || candidate > definition.max
    ) return false;
  }

  return (input.smallestNode as number) <= (input.largestNode as number);
}

export function formatMemoryGraphSettingValue(key: keyof MemoryGraphSettings, value: number): string {
  return value.toFixed(DEFINITION_BY_KEY.get(key)?.precision ?? 2);
}
