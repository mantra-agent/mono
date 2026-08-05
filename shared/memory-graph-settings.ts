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
  tagDegreeThreshold: number;
  baseColor: string;
  recentColor: string;
}

/** Numeric (slider) keys — every value is a bounded number. */
export type NumericMemoryGraphSettingKey = Exclude<keyof MemoryGraphSettings, "baseColor" | "recentColor">;

/** Color (picker) keys — every value is a #rrggbb hex string. */
export type ColorMemoryGraphSettingKey = "baseColor" | "recentColor";

export interface MemoryGraphSettingDefinition {
  key: NumericMemoryGraphSettingKey;
  label: string;
  min: number;
  max: number;
  step: number;
  precision: number;
}

export interface MemoryGraphColorDefinition {
  key: ColorMemoryGraphSettingKey;
  label: string;
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
  // Minimum distinct entities a tag must link before its node renders. The
  // server ships every tag with >= 1 projected connection; this Mixer knob owns
  // the density policy client-side (raise to declutter hubs, lower to reveal).
  tagDegreeThreshold: 2,
  // Defaults sampled from the theme tokens the graph previously read at runtime:
  // baseColor ≈ --cta (hsl 200 80% 50%), recentColor ≈ dark-mode --foreground.
  baseColor: "#1aa1e6",
  recentColor: "#e9eaed",
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
  { key: "tagDegreeThreshold", label: "Tag Degree Threshold", min: 1, max: 12, step: 1, precision: 0 },
] as const;

export const MEMORY_GRAPH_COLOR_DEFINITIONS: readonly MemoryGraphColorDefinition[] = [
  { key: "baseColor", label: "Base Color" },
  { key: "recentColor", label: "Recent Color" },
] as const;

const COLOR_KEYS = new Set<string>(MEMORY_GRAPH_COLOR_DEFINITIONS.map((definition) => definition.key));
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return isValidHexColor(value) ? value.trim().toLowerCase() : fallback;
}

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

  for (const definition of MEMORY_GRAPH_COLOR_DEFINITIONS) {
    settings[definition.key] = normalizeHexColor(
      input[definition.key],
      MEMORY_GRAPH_SETTINGS_DEFAULTS[definition.key],
    );
  }

  settings.smallestNode = Math.min(settings.smallestNode, settings.largestNode);
  settings.largestNode = Math.max(settings.largestNode, settings.smallestNode);
  return settings;
}

function hasValidMemoryGraphSettingValues(input: Record<string, unknown>): boolean {
  for (const key of Object.keys(input)) {
    const candidate = input[key];
    if (COLOR_KEYS.has(key)) {
      if (!isValidHexColor(candidate)) return false;
      continue;
    }
    const definition = DEFINITION_BY_KEY.get(key as NumericMemoryGraphSettingKey);
    if (
      !definition
      || typeof candidate !== "number"
      || !Number.isFinite(candidate)
      || candidate < definition.min
      || candidate > definition.max
    ) return false;
  }
  if (typeof input.smallestNode === "number" && typeof input.largestNode === "number") {
    return input.smallestNode <= input.largestNode;
  }
  return true;
}

const NUMERIC_KEY_COUNT = MEMORY_GRAPH_SETTING_DEFINITIONS.length;
const COMPLETE_KEY_COUNT = NUMERIC_KEY_COUNT + MEMORY_GRAPH_COLOR_DEFINITIONS.length;

export function isCompleteMemoryGraphSettings(value: unknown): value is MemoryGraphSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === COMPLETE_KEY_COUNT
    && hasValidMemoryGraphSettingValues(input);
}

/** Accepts recent complete snapshots during rolling client upgrades. */
export function isAcceptedMemoryGraphSettingsSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const isCurrent = keys.length === COMPLETE_KEY_COUNT;
  const isLegacyWithoutColors = keys.length === NUMERIC_KEY_COUNT;
  const isLegacyWithoutPulseSize = keys.length === NUMERIC_KEY_COUNT - 1 && !("pulseSize" in input);
  const isLegacyWithoutTagThreshold = keys.length === COMPLETE_KEY_COUNT - 1 && !("tagDegreeThreshold" in input);
  return (isCurrent || isLegacyWithoutColors || isLegacyWithoutPulseSize || isLegacyWithoutTagThreshold)
    && hasValidMemoryGraphSettingValues(input);
}

export function formatMemoryGraphSettingValue(key: NumericMemoryGraphSettingKey, value: number): string {
  return value.toFixed(DEFINITION_BY_KEY.get(key)?.precision ?? 2);
}
