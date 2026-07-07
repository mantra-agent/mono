/** Semantic categorical color mappings for typed UI elements.
 *
 * Usage:
 *   import { CATEGORY_COLORS } from "@/lib/category-colors";
 *   <span className={CATEGORY_COLORS.thinking.text}>...</span>
 *   <div className={`${CATEGORY_COLORS.event.bg} ${CATEGORY_COLORS.event.border}`}>...</div>
 *
 * Legacy category keys now resolve to the approved semantic tokens in DESIGN.md.
 */
export const CATEGORY_COLORS = {
  // AI & cognition (cat-ai)
  thinking: { text: "text-cta", bg: "bg-cta/10", border: "border-cta/30" },
  observation: { text: "text-cta", bg: "bg-cta/10", border: "border-cta/30" },

  // Events & changes (cat-event)
  event: { text: "text-info-foreground", bg: "bg-info/10", border: "border-info/30" },
  change: { text: "text-info-foreground", bg: "bg-info/10", border: "border-info/30" },
  gateway: { text: "text-info-foreground", bg: "bg-info/10", border: "border-info/30" },

  // Sessions & communication (cat-channel)
  session: { text: "text-info-foreground", bg: "bg-info/10", border: "border-info/30" },
  channel: { text: "text-info-foreground", bg: "bg-info/10", border: "border-info/30" },

  // Connections & growth (cat-growth)
  connection: { text: "text-success-foreground", bg: "bg-success/10", border: "border-success/30" },
  growth: { text: "text-success-foreground", bg: "bg-success/10", border: "border-success/30" },
  health: { text: "text-success-foreground", bg: "bg-success/10", border: "border-success/30" },

  // Alerts & urgency (cat-alert)
  alert: { text: "text-error-foreground", bg: "bg-error/10", border: "border-error/30" },
  failure: { text: "text-error-foreground", bg: "bg-error/10", border: "border-error/30" },

  // Skills & system (cat-system)
  skill: { text: "text-neutral-foreground", bg: "bg-neutral/10", border: "border-neutral/30" },
  system: { text: "text-neutral-foreground", bg: "bg-neutral/10", border: "border-neutral/30" },
} as const;

/** Type for any known category key */
export type CategoryKey = keyof typeof CATEGORY_COLORS;
