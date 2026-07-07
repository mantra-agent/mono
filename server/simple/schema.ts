import { z } from "zod";
import { SIMPLE_SECTIONS, SIMPLE_SOURCE_TYPES, SIMPLE_WIDGET_TYPES } from "@shared/models/simple";

const referenceRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  raw: z.string().optional(),
  canonical: z.string().min(1),
  legacy: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const simpleSourceRefSchema = z.object({
  type: z.enum(SIMPLE_SOURCE_TYPES),
  id: z.string().min(1),
  label: z.string().optional(),
  href: z.string().optional(),
  observedAt: z.string().optional(),
});

export const simpleActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["navigate", "complete", "log", "discuss", "open_source"]),
  href: z.string().optional(),
  sourceRef: simpleSourceRefSchema.optional(),
  payload: z.record(z.unknown()).optional(),
});

export const simpleFeedItemSchema = z.object({
  id: z.string().min(1),
  section: z.enum(SIMPLE_SECTIONS),
  widgetType: z.enum(SIMPLE_WIDGET_TYPES),
  title: z.string().min(1).max(200),
  status: z.enum(["active", "completed", "dismissed", "stale"]).optional(),
  priority: z.number().optional(),
  sourceRefs: z.array(simpleSourceRefSchema).min(1),
  references: z.array(referenceRefSchema).optional(),
  payload: z.record(z.unknown()).default({}),
  actions: z.array(simpleActionSchema).optional(),
  completedAt: z.string().optional(),
  anchorTime: z.string().optional(),
  actionTime: z.string().optional(),
  time: z.string().optional(),
  children: z.lazy(() => z.array(simpleFeedItemSchema)).optional(),
  completable: z.boolean().optional(),
});

export const simpleFeedSchema = z.object({
  id: z.string().min(1),
  generatedAt: z.string().min(1),
  timezone: z.string().min(1),
  anchor: z.literal("now"),
  sections: z.array(z.object({
    section: z.enum(SIMPLE_SECTIONS),
    items: z.array(simpleFeedItemSchema),
  })),
  stale: z.boolean().optional(),
  degraded: z.boolean().optional(),
  errors: z.array(z.object({ source: z.string(), message: z.string() })).optional(),
});

const nannyPatterns = [
  /you\s+(haven't|have not|ignored|need to|should|must)/i,
  /behind on/i,
  /overdue again/i,
  /failed to/i,
];

export function lintSimpleTitle(title: string): string | null {
  const match = nannyPatterns.find(pattern => pattern.test(title));
  return match ? `nanny-tone:${match}` : null;
}

export function validateSimpleFeed(input: unknown) {
  const parsed = simpleFeedSchema.parse(input);
  const errors: string[] = [];
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const tone = lintSimpleTitle(item.title);
      if (tone) errors.push(`${item.id}:${tone}`);
      if (item.sourceRefs.length === 0) errors.push(`${item.id}:missing-sourceRefs`);
    }
  }
  if (errors.length) throw new Error(`Invalid Simple feed: ${errors.join(", ")}`);
  return parsed;
}
