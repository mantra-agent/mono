# Design System

> Machine-readable design tokens + human-readable rationale.
> Format: [Google DESIGN.md](https://github.com/nicholasgasior/design.md) (Apache 2.0)

---

## Philosophy

**Zero Interface.** The best possible interface is no interface. The second best is the theoretical minimum that matters at any given moment. Not a dashboard, not a form. A dynamic surface, generated just-in-time for whatever matters most. Every design decision is measured against this: does it move toward the theoretical minimum, or does it add surface area the user must manage?

**Dark Canvas, Trees for UI, Glass for Modals.** The background is the interface. `bg-background` (pure black in dark mode) is the default canvas. Route and embedded UIs sit directly on that canvas and organize objects through the canonical Hierarchy Tree: compact rows, nesting, disclosure, selection, and structural separators. Do not use Cards as page, dashboard, settings, detail, or object-grouping containers. Every modal decision surface uses `MODAL_GLASS_SURFACE_CLASS`, the same canonical glass format as toasts: translucent warm-dark gradient, white structural edge and highlights, deep shadow, and `backdrop-blur-xl`. Glass sheen layers paint under content (`isolate` + negative z-index), and modal copy uses white / white-soft text — never canvas `text-muted-foreground` on glass. Preserve the standard black overlay behind the modal; glass replaces only the modal surface. Borders are structural separators (`border-b border-border/20`), not decoration.

**Clarity Above All.** Remove everything that isn't essential. Every element on screen earns its place through utility, orientation, or delight. Maximize Tufte's data-ink ratio. If removing an element changes nothing about comprehension, it shouldn't be there.

**Occam's Design.** Always do things the simplest way, but no simpler. Use standard patterns when they solve the problem. Every custom component is complexity debt: learned, maintained, documented, defended. Simple systems feel inevitable. Complex systems feel fragile.

**Human-Scale.** Generous touch targets (44px minimum). Readable typography (14px body minimum, 1.5 line height for prose). Comfortable spacing. Warm and approachable, not clinical and cold. The body has opinions about what feels right. Respect them.

**The Symbiotic Bridge.** This interface translates between human intent and AI cognition. It renders the black box visible. Both sides see the same reality through the same window, at whatever depth the moment requires. Transparency improves trust and task outcomes by reducing information asymmetry.

**Taste Is a Feature.** Some decisions are guided by craft and intuition, not metrics. Taste is the thousand micro-decisions (spacing, timing, word choice, color temperature) that add up to something that feels cared for. It's the difference between Linear and Jira.

**Opinionated by Default.** Present the right choice, not every choice. Defaults reflect strong product judgment. Every option exposed is a decision the user must make. Every decision costs cognitive energy. Pick the best default so most users never touch it.

**Baseball Card Interfaces.** Front side: simple, interesting, and actionable. Show what matters today, the surprising insight, or the one thing worth attention. Back side: full stats, provenance, logs, settings, and system detail. Progressive complexity means the system reveals depth through use instead of forcing a feature tour. Onboarding should feel like a coach or therapist earning understanding before introducing capabilities.

**Mobile-First, Always.** Design for the smallest viewport first. Single-column layouts stack naturally. Multi-column grids are progressive enhancement at `@md` and above. Touch targets, text sizes, and spacing should work at 375px before they work at 1440px. If something overflows on mobile, it's broken everywhere.

**Design the System, Not the Screen.** Compose from tokens. A screen designed in isolation will be beautiful once and inconsistent forever. A screen composed from a well-designed system will be consistent always.

**Name by Role, Not by Value.** Every token, variable, class, and component name should describe its purpose in the system, not its current appearance or implementation. If the name would become misleading after a valid change to the underlying value, the name is wrong. This prevents leaky abstractions where implementation details (a specific color, a pixel size) bleed into the naming layer, making future theme changes, accessibility modes, or palette swaps require renaming instead of just remapping values. Good: `cat-ai`, `cat-alert`, `cat-event`. Bad: `cat-purple`, `cat-orange`, `spacing-16px`.

---

## Colors

All values are HSL channel triplets consumed via `hsl(var(--token))`.
Color encodes function, not decoration. The interface should remain legible and correctly prioritized in grayscale; hue is an extra layer of meaning, not the structure itself.

### Core distinction

`primary` and `cta` are different roles.

- **Primary** is an alias of `foreground`: full-strength primary text, selected-but-not-urgent states, and calm structural emphasis. Do not create a near-white variation; secondary hierarchy already uses `muted-foreground`.
- **CTA** is the brand/action color: the single strongest hue on a screen, reserved for the one action the user should notice first.

CTA is the only interactive hue. Scarcity now means hierarchy, not a separate purple family: primary CTAs are filled; secondary CTAs, links, and resolved references use CTA as text. Background tints, panels, generic icons, badges, and decorative examples still do not get CTA.

```yaml
colors:
  light:
    background:            "220 14% 96%"
    foreground:            "220 14% 10%"
    card:                  "220 14% 100%"
    card-foreground:       "220 14% 10%"
    card-border:           "220 10% 88%"
    popover:               "220 14% 100%"
    popover-foreground:    "220 14% 10%"
    popover-border:        "220 10% 86%"
    primary:               "var(--foreground)" # alias of foreground, not CTA
    primary-foreground:    "220 14% 98%"
    cta:                   "200 80% 50%"   # protected action/interactive color, blue
    cta-foreground:        "220 14% 98%"
    active:                "200 80% 75%"    # CTA mixed halfway toward white for active/running status
    active-foreground:     "220 14% 98%"
    secondary:             "220 10% 90%"
    secondary-foreground:  "220 14% 10%"
    muted:                 "220 10% 92%"
    muted-foreground:      "220 10% 40%"
    accent:                "220 12% 92%"
    accent-foreground:     "220 14% 10%"
    destructive:           "350 65% 52%"
    destructive-foreground: "0 5% 98%"
    border:                "220 10% 90%"
    input:                 "220 10% 80%"
    ring:                  "200 80% 50%"

  dark:
    background:            "0 0% 0%"       # pure black — canonical darkest surface
    foreground:            "220 10% 92%"
    card:                  "222 20% 11%"
    card-foreground:       "220 10% 92%"
    card-border:           "222 16% 15%"
    popover:               "222 20% 13%"
    popover-foreground:    "220 10% 92%"
    popover-border:        "222 16% 20%"
    primary:               "var(--foreground)" # alias of foreground, not CTA
    primary-foreground:    "222 20% 8%"
    cta:                   "200 80% 50%"   # protected action/interactive color, blue
    cta-foreground:        "220 14% 98%"
    active:                "200 80% 75%"    # CTA mixed halfway toward white for active/running status
    active-foreground:     "220 14% 98%"
    secondary:             "222 16% 16%"
    secondary-foreground:  "220 10% 92%"
    muted:                 "222 16% 14%"
    muted-foreground:      "220 10% 55%"
    accent:                "222 16% 16%"
    accent-foreground:     "220 10% 92%"
    destructive:           "350 65% 52%"   # merged alert/error hue
    destructive-foreground: "0 5% 98%"
    border:                "222 16% 16%"
    input:                 "222 16% 22%"
    ring:                  "200 80% 50%"

  sidebar:
    light:
      background:          "222 20% 14%"
      foreground:          "220 10% 92%"
      border:              "222 16% 20%"
      primary:             "var(--sidebar-foreground)"
      primary-foreground:  "222 20% 8%"
      cta:                 "200 80% 50%"
      cta-foreground:      "220 14% 98%"
      accent:              "222 16% 20%"
      accent-foreground:   "220 10% 92%"
      ring:                "200 80% 50%"
    dark:
      background:          "222 22% 10%"
      foreground:          "220 10% 92%"
      border:              "222 16% 16%"
      primary:             "var(--sidebar-foreground)"
      primary-foreground:  "222 20% 8%"
      cta:                 "200 80% 50%"
      cta-foreground:      "220 14% 98%"
      accent:              "222 16% 16%"
      accent-foreground:   "220 10% 92%"
      ring:                "200 80% 50%"

  charts:
    light:
      chart-1:             "142 70% 45%"   # green, only when chart series requires it
      chart-2:             "200 80% 50%"
      chart-3:             "262 70% 55%"
      chart-4:             "40 90% 55%"
      chart-5:             "350 65% 52%"
    dark:
      chart-1:             "142 70% 50%"
      chart-2:             "200 80% 55%"
      chart-3:             "262 70% 60%"
      chart-4:             "40 90% 60%"
      chart-5:             "350 65% 58%"

  status:
    needs-attention:       "var(--foreground)" # full foreground emphasis, no amber
    normal:                "220 10% 55%"   # muted foreground
    success:               "174 70% 42%"   # aqua confirmation/health
    warning:               "34 82% 52%"    # actual caution/probable risk only
    error:                 "356 64% 54%"   # failures, destructive risk, broken invariants
    info:                  "200 80% 50%"
    neutral:               "220 10% 55%"

  deprecated_categorical:
    ai:       "deprecated: replace with text/icon/label unless color carries necessary function"
    event:    "deprecated: was orange catch-all; do not use for needs-attention"
    channel:  "deprecated: replace with text/icon/label unless color carries necessary function"
    growth:   "deprecated: replace with text/icon/label unless color carries necessary function"
    alert:    "merge into error/destructive semantic"
    system:   "deprecated: replace with text/icon/label unless color carries necessary function"

  surface:
    elevate-1-light:       "rgba(0,0,0, .03)"
    elevate-2-light:       "rgba(0,0,0, .08)"
    elevate-1-dark:        "rgba(255,255,255, .04)"
    elevate-2-dark:        "rgba(255,255,255, .09)"
    button-outline-light:  "rgba(0,0,0, .10)"
    button-outline-dark:   "rgba(255,255,255, .10)"
    badge-outline-light:   "rgba(0,0,0, .05)"
    badge-outline-dark:    "rgba(255,255,255, .05)"
```

### Background color system

Background color is structural first, semantic only when the surface is literally communicating state. Do not tint panels because they feel important. The default and required page surface is the canvas (`bg-background`).

- **Route and embedded UIs**: Content sits directly on the canvas. Object sets and structured data use the canonical Hierarchy Tree, not Cards.
- **Grouping**: Use tree sections, indentation, quiet rails, row expansion, and structural borders. Do not create a Card merely to establish visual separation.
- **Modal surfaces**: Every modal, alert dialog, modal sheet, and modal drawer uses `MODAL_GLASS_SURFACE_CLASS`. It is the exact shared toast glass format: translucent warm-dark gradient, white structural edge/highlights, deep shadow, `overflow-hidden`, `min-w-0`, `backdrop-blur-xl`, and sheen layers stacked *under* content via `isolate` + `before/after:-z-10`. Modal titles use `text-white`; descriptions and secondary copy use `text-white/70`. Do not put canvas `text-muted-foreground` on glass — it washes out. Keep the standard black overlay behind it; do not replace the overlay or black canvas with glass.
- **Editable fields (settings, secrets, credentials, object detail)**: These are TreeView rows, not cards and not standalone `Input`+`Button` forms. Compose `ProfileDetailSection` (the collapsible group header) with `ProfileTreeRow` (one row per field): label + icon on the left, the value or an inline right-aligned input as the row's child, and any rotate/clear/destructive action in the `menuContent` hover overflow menu. When a field is being edited, open the input inline beneath or within the row — never in a `rounded-lg border bg-card` box. The canonical live references are the SOURCE section on the environment detail page and the Secrets screen; the pattern is demonstrated on the in-app Design page under Components → "Edit fields".

| Role | Token/class | Use | Forbidden |
|---|---|---|---|
| Page canvas | `background` / `bg-background` | Full page, root panels, terminal/log canvases. **Default surface for all content.** | — |
| Modal decision surface | `MODAL_GLASS_SURFACE_CLASS` | Dialogs, alert dialogs, modal sheets, modal drawers, and custom modal surfaces. Preserve the black overlay behind it. Content sits above glass sheen; use white / white-soft text. | `bg-background`, `bg-card`, one-off gradients, removing/replacing the black overlay, sheen over text, or canvas `text-muted-foreground` on glass |
| Passive inset | `muted` / `bg-muted` | Code, metadata wells, disabled zones, quiet nested areas | Selected state, CTA emphasis, alerts |
| Hover/selected chrome | `accent` / `bg-accent` | Transient hover, selected navigation rows, neutral UI chrome | Persistent semantic callouts |
| Primary CTA fill | `cta` / `bg-cta` | The one primary action button or equivalent decisive control | Background tints, panels, generic icons, badges, decorative examples |
| Secondary CTA / interactive text | `cta` / `text-cta` | Secondary actions, links, and resolved reference links | Filled buttons, status, decoration |
| Text/link hover | `active` / `hover:text-active` | Hover state for hyperlinks and resolved reference links, especially when already underlined | Rest state, status, decoration |
| Success tint | `success` / `bg-success/10` | Completed/confirmed state callouts, aqua | Action prompts, “good example” decoration |
| Warning tint | `warning` / `bg-warning/10` | Actual caution or probable risk | Generic needs-attention or review requests |
| Error tint | `error` / `bg-error/10` | Failures, broken invariants, destructive risk | Warnings, attention, non-error decoration |
| Active | `active` / `text-active` | Lighter CTA blue for in-progress/running status, including spinners and active status icons | Background tints, primary CTA fill, links, generic selected state |

Audit finding: the client currently has many semantic background usages (`bg-primary`, `bg-info`, `bg-success`, `bg-warning`, `bg-error`, `bg-cat-*`). Treat the table above as the migration target. Existing usages should be corrected opportunistically when touching a surface; new code must obey this table.

### CTA rules

- Use `cta` for the primary action on a screen. One screen, one filled CTA.
- Use CTA directly as the interactive text color for secondary actions, textual links, and resolved reference links. Do not maintain a separate link color family.
- **Screen:** the full route/page or modal-level workflow.
- **Viewport:** the currently visible part of that screen. Never show two primary CTAs in the same viewport.
- **Region:** a contained module or tree branch inside a screen. Regions may have secondary, outline, ghost, or text actions, but they do not earn their own CTA unless they are the whole decision surface.
- **Decision surface:** an isolated workflow moment where the user chooses the next meaningful action. It can be a full page, modal, or focused stepper; only the modal form may use a Card.
- Do not use CTA color for category badges, decorative icons, charts, secondary buttons, selected tabs, generic active states, or status indicators.
- If more than one element uses the CTA hue, the screen must identify the one true action and demote the rest to foreground, outline, muted, secondary, or text treatment.
- Focus rings may use the CTA hue because focus is transient interaction feedback, not persistent visual competition.

### Attention and status rules

- Needs attention is a hierarchy state, not an amber category. Use full foreground/white emphasis, stronger weight, position, and copy.
- No attention / normal / resolved states use `muted-foreground`.
- Warning is reserved for actual caution, probable risk, or a reversible problem that may become failure. Do not use warning for generic "important."
- Error, alert, destructive risk, broken invariants, and failed operations use the merged error/destructive hue based on the former `cat-alert` color.
- Success is state confirmation, not CTA. Success uses aqua and should never compete with the primary action.

### Categorical color rules

- Existing `cat-*` tokens are legacy audit targets. Remove or remap them during page-by-page cleanup.
- Only introduce a category hue when the user must distinguish that type pre-attentively and the distinction cannot be carried by structure or text.
- Vault identity is a bounded exception because color carries persistent partition context across surfaces. Every vault picker and renderer must source the canonical light-tinted family from `VAULT_COLOR_PALETTE` in `shared/models/vaults.ts`; do not create local vault swatches. Full white is the semantic default for Personal; generic new vaults begin on the light Sky tint. Persisted custom vault colors remain valid.

### Color rules

- Always use semantic tokens (`bg-card`, `text-foreground`, `border-border`, `bg-cta`), never raw hex/hsl values.
- Never use Tailwind palette colors (`zinc-500`, `slate-200`, etc.) directly. Map to semantic tokens.
- Color is functional, not decorative. Every color has a defined semantic meaning.
- Primary aliases `foreground`. CTA is the brand/action color. Do not collapse primary/foreground with CTA, and do not create near-white variants when `muted-foreground` already carries secondary hierarchy.
- Destructive/error is for irreversible actions, failures, destructive risk, and broken invariants.
- Warm neutrals, not cool grays. Cool grays feel clinical, warm grays feel human.
- Chart colors are subordinate to interface hierarchy. A chart may use hue, but it must not look like a cluster of CTAs.

### Color proportions

- **60% Neutral** — Background, modal Cards, and muted surfaces (`background`, `card`, `muted`). The quiet canvas.
- **30% Supporting** — Secondary surfaces, borders, navigation chrome (`secondary`, `accent`, `border`, sidebar). Creates grouping without competing.
- **10% Accent** — The protected CTA, true warnings/errors, and necessary status. The color that means "look here."
- If accent color exceeds ~10-15% of visible pixels, the interface is over-saturated.
- **Squint test:** Blur the screen to 5px. If more than one persistent colored element pulls your eye, the CTA is not protected.
- **Hue count:** Count the distinct hues on any screen. If more than 3 hues compete for attention, simplify.

---

## Typography

```yaml
typography:
  fonts:
    sans:  "Inter, sans-serif"
    serif: "Georgia, serif"
    mono:  "JetBrains Mono, Fira Code, monospace"

  scale:
    2xs:   "0.625rem"   # 10px — micro text (restricted use, see rules below)
    xs:    "0.75rem"    # 12px — captions, timestamps, metadata
    sm:    "0.875rem"   # 14px — secondary text, labels, table cells
    base:  "1rem"       # 16px — body text, primary content
    lg:    "1.125rem"   # 18px — section headers, emphasis
    xl:    "1.25rem"    # 20px — page subtitles
    2xl:   "1.5rem"     # 24px — page titles
    3xl:   "1.875rem"   # 30px — hero headings (rare)

  weights:
    normal:   400       # body text, descriptions
    medium:   500       # labels, nav items, table headers
    semibold: 600       # emphasis, modal titles, section headers
    bold:     700       # page headings only

  line-height:
    tight:    1.25      # headings
    normal:   1.5       # body text, descriptions
    relaxed:  1.625     # long-form prose

  tracking:
    normal:   "0em"
```

### Typography rules

- The type scale approximates a Major Third (1.25) modular ratio with deliberate deviations for readability at small sizes. This means each step is roughly 1.25× the previous (16 → 20 → 24 → 30). Pure modular scales extend trivially; ours prioritizes pixel-grid friendliness.
- Type carries 90% of the information. Treat font, size, weight, spacing, and line length as structural decisions with the same rigor as database schema.
- Body text minimum: 14px (`text-sm`). Never smaller for readable content.
- Use at most 4 sizes per screen. If you need a 5th, simplify the hierarchy.
- Weight progression: normal → medium → semibold → bold. Skip sparingly.
- Visual hierarchy is navigation: size, weight, color, and position establish what matters most, second, and what's available if needed.
- Muted foreground for secondary text. Full foreground for primary. `primary`, `foreground`, and `active` are one foreground color expressed through semantic aliases.
- Monospace only for code, IDs, technical values.
- `text-2xs` (10px) is the absolute floor. Restricted to four contexts only: numeric counters in badges (1-3 chars), uppercase labels with `tracking-wider`, status badges where shape carries more meaning than text, and chart annotations.
- `text-2xs` must never be used for sentences or any text a user needs to read character-by-character. If it needs reading, use `text-xs` (12px) minimum.
- On pages where `text-2xs` is used, verify legibility on a non-Retina display. Inter renders with semi-opaque pixel stems below 12px.
- Establish hierarchy through this sequence: **size → weight → color → spacing**. Most screens need only 2-3 of these. Using all 4 simultaneously on the same element is overdesigned.
- Three tiers of text emphasis: `foreground` (primary content), `muted-foreground` (secondary/supporting), and `muted-foreground` at reduced opacity (tertiary/ambient). Size alone is not enough — weight and color do more work in dense interfaces.
- Responsive downgrades are allowed when space is constrained, but the semantic role does not change. Example: a page title may render `text-xl md:text-2xl`; it is still a page title whose canonical desktop token is `text-2xl`, not a global redefinition of page titles as `text-xl`.

---

## Spacing

```yaml
spacing:
  base: 8px
  scale:
    tight: "gap-2"      # 8px, controls and tight rows
    default: "gap-4"    # 16px, ordinary groups
    section: "gap-6"    # 24px, major sections
  padding:
    compact: "p-2"
    default: "p-4"
    section: "p-6"
```

Spacing clarifies hierarchy. It should not create decorative layout anatomy.

### Spacing rules

- Use the 8px rhythm.
- Tight controls use `gap-2`.
- Ordinary groups use `gap-4`.
- Major sections use `gap-6`.
- Full-width containers are the default. Spacing should organize the canvas without inventing wrappers.
- Keep proportional/phi spacing guidance as a secondary judgment aid, not a component API.

## Motion

Motion is functional orientation. It should help the user understand continuity, state, and hierarchy without making the interface feel theatrical.

```yaml
motion:
  default-duration: "150ms"
  complex-duration: "200ms"
  easing: "ease-out"
  allowed:
    - hover color shifts
    - disclosure rotation
    - loading shimmer or pulse
    - panel entrance when spatial continuity matters
    - subtle object-state confirmation
  prohibited:
    - decorative bounce
    - delayed content
    - motion that hides latency
    - motion that changes layout unexpectedly
```

### Motion rules

- Animate state transitions, not decoration.
- Disclosure controls rotate. They do not slide the page around.
- Full-screen and page-level loading uses one centered circular `Loader2` spinner in `text-muted-foreground`. Skeletons are reserved for inline content whose eventual shape is already known; never represent a loading screen as a flashing rectangle.
- Use motion to preserve continuity when panels, trees, or object rows expand and collapse.
- Respect reduced-motion preferences where available.

## Layout

The current product layout is the source of truth. The old prescriptive page-shell doctrine was too broad and did not match all real pages.

```yaml
layout:
  canvas: "full-width by default"
  page-content: "structured by hierarchy, grids, and sections"
  reading-width: "only for reading-heavy prose or focused forms"
  anatomy: "not a standalone design primitive"
```

### Layout rules

- Page-level and tab-level content default to full width.
- Root pages have one title and no subtitle, descriptive tagline, or explanatory paragraph beneath it. Put essential guidance at the point of action or inside the relevant detail surface.
- New root-page UI/UX must use the established SessionMenu-style Hierarchy Tree format as its primary object surface: search first, a persistent blue `+ New Thing` row, collapsible section labels, and compact nested rows. A different root-page structure requires an explicit product exception.
- Use grids, hierarchy tree, tabs, and sections for structure.
- Do not add `max-w-* mx-auto` to page containers unless the surface is reading-heavy or a focused form.
- Do not create a generic “layout anatomy” block. Actual product surfaces decide structure from object relationships.
- Mobile support is required, but desktop density is the primary product target.

## Components

Components are quiet machinery. They should be recognizable, compact, tokenized, and composed from shared primitives.

```yaml
components:
  base: "shadcn/ui + Tailwind tokens"
  style: "flat, compact, dark-canvas native"
  hierarchy-first: true
  bespoke-components: "only when shared primitives cannot express the object model"
```

### Hierarchy Tree

Hierarchy Tree is the primary modality for surfacing UI objects.

Use it for every route or embedded UI that surfaces objects or structured data. Tables and bespoke layouts require a constraint the tree cannot represent truthfully; Cards are not an alternative outside modals.

```yaml
hierarchy-tree:
  order:
    - search
    - primary creation action
    - collapsible sections
    - nested object rows
  row:
    height: "compact"
    label: "truncate"
    meta: "right aligned when useful"
    actions: "row-local, horizontal ellipsis, revealed on hover or keyboard focus"
  behavior:
    selection: "single selected row when context needs it"
    expansion: "chevron rotation"
    completion: "inline check control for completable objects"
    editing: "fields and dates edit in place"
    references: "canonical reference widgets expand inline when context is useful"
    nesting: "visible rails or indentation"
  panel:
    orientation: "always vertical"
    mobile: "full display"
    web: "full display"
  detail:
    expansion: "inline beneath the selected row, indented with a quiet left rail"
    split-view: "never"
```

#### Hierarchy Tree rules

- For new root pages and embedded object UIs, mirror the SessionMenu interaction grammar rather than inventing a page-local list, card grid, dashboard panel, or table.
- Search comes first.
- Creation sits directly under search when creation is a primary action. Use the blue `+ New Thing` row as the persistent primary CTA.
- Use collapsible sections to reduce scanning cost.
- Preserve semantic status through icons, checks, and muted metadata.
- Edit short fields in place. Use `InlineDatePicker` for dates.
- Render canonical references with the shared reference renderer. When a reference has useful Simple-view context, expand that context directly beneath its row rather than opening a detached card.
- Prefer one compact tree over separate cards, lists, and detail fragments.
- Selected objects expand inline beneath their row, accordion-style, reusing the object's detail styling inside the expanded body (as in Projects and Simple). Never open a horizontal split-view master-detail panel for a hierarchy tree page.
- The hierarchy tree panel is always one vertical screen. Mobile and web use the same full-display tree. Do not keep a desktop-only left-third list that morphs into a second pane.

#### TreeView grammar

TreeView is one interaction language with two compositions. Cards are not a third.

**Object index** — Session Menu, Features, Scenarios, Issues, Audiences, Timers. Search first. Blue `+ New Thing` next. Collapsible section labels. Compact nested rows. Hover or keyboard `…` menu. Inline expand. No split-view.

**Field / detail** — Person profile, Secrets, Environment SOURCE, Slack, Claude CLI, OpenAI Subscription, OpenAI API, Anthropic API, Model tab, ElevenLabs, Twitter, Expo. `ProfileDetailSection` or `IntegrationTreeSection` as the group. One `ProfileTreeRow` per field: label and optional icon on the left, value or inline input on the right. Fields and dates edit in place; rotate, clear, and destructive actions live in `menuContent`. Children nest with `HierarchyTreeRow`. Person profile is the archetype: it is the origin of `ProfileDetailSection`/`ProfileTreeRow` and the reference implementation for in-place editable rows.

Required primitives:

- Stack / CTA / section: `HIERARCHY_TREE_STACK_CLASS`, `HIERARCHY_PRIMARY_ACTION_CLASS`, `HIERARCHY_SECTION_HEADER_CLASS`
- Rows: `ProfileTreeRow`, `HierarchyTreeRow`, `ProfileDetailSection`

Do not invent a page-local list, card grid, dashboard panel, or Input+Button settings form. A leftover `Card` on a route is migration debt. Cards belong only on modal decision surfaces (`MODAL_GLASS_SURFACE_CLASS`).

Canonical live references: Session Menu for object indexes; Person profile, Environment SOURCE, and Secrets for editable field rows; Claude CLI credentials for wrapping `SecretsForSection` inside a tree. The Design page Hierarchy Tree playground and Components → Edit fields demonstrate both compositions.

### Zero states

A zero state is the normal empty form of a surface, not a hero, onboarding panel, or marketing moment. Keep the surface's useful scaffolding visible and replace missing objects with one quiet row.

```yaml
zero-state:
  preserve:
    - search
    - primary creation action
    - section structure when it helps orientation
  row:
    copy: "No {things} yet."
    style: "text-sm text-muted-foreground"
    alignment: "left aligned at the object's tree depth"
    spacing: "px-2 py-1.5"
  prohibit:
    - hero icons or icon circles
    - centered layouts
    - headings plus explanatory paragraphs
    - CTA buttons inside the empty area
    - dashed or decorative empty cards
```

The persistent blue `+ New Thing` action is the CTA. Do not add a second action inside the empty area. Search-result emptiness follows the same quiet-row pattern with precise copy such as `No matching goals.`

Chat is an explicit exception. Its Mantra mark and conversation prompt are part of the conversational canvas, not a reusable zero-state pattern. Errors, loading states, and permission states are also separate patterns.

### Buttons

- Primary action: `bg-cta text-cta-foreground`.
- Secondary action: outline, ghost, or muted surface.
- Destructive action: destructive token only when the action is genuinely destructive.
- Buttons should be short. If a button needs a sentence, the surrounding surface is doing too little.

### Action menus

- **MUST use the canonical `DropdownMenu` primitive** from `client/src/components/ui/dropdown-menu.tsx` for action menus. Do not create a local menu, render raw Radix dropdown primitives, or introduce a parallel responsive-menu component.
- Declare one action hierarchy with `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, and the canonical nested/group variants. The primitive owns presentation by modality; consumers must not branch on viewport or native-app state.
- Nested actions drill into the current menu body and expose Back on mobile; desktop retains conventional pointer-friendly flyout submenus.
- Mobile action menus use the Universal Picker's visual grammar: an inset black panel, thin border, small radius, no handle, no heavy shadow, and bounded overflow. They must not render as desktop flyouts or action sheets.
- Mobile rows use the Universal Picker's dense single-line rhythm with quiet 14px icons and full-width selected states. The shared presenter measures the real trigger, opens in the larger adjacent viewport region, and gives the panel one scroll boundary so every action remains reachable.
- Keyboard access, visible focus, disabled semantics, dismissal, and focus return are mandatory.
- The Design screen's **Responsive action menus** playground is the canonical visual and interaction example. Any change to action-menu behavior must update that example and this section together.
- The same compact grammar governs menus, selectors, and action/selection popovers: content-sized surfaces, `p-1` framing, compact single-line rows, quiet 14px icons, restrained radius and shadow, and bounded overflow. Explicit picker width may grow for search/results; task dialogs, workflow modals, tooltips, and hover cards are separate patterns and must not be compressed into this grammar.

### Inputs

- Inputs use tokenized border, background, focus ring, and placeholder color.
- Search inputs should include a left search icon and a clear action when populated.
- Labels stay close to the control they describe.

### Inline date editing

- The canonical inline date-editing pattern is `InlineDatePicker` (`client/src/components/inline-date-picker.tsx`).
- The trigger is the date itself (or a calendar icon when unset). Clicking it opens the OS-native date picker directly via `showPicker()`; choosing a date commits immediately. No intermediate edit box, no edit-mode toggle.
- Do not render a visible `<Input type="date">` for inline date edits in rows, widgets, or profile fields. Visible date inputs are acceptable only inside explicit creation/edit forms.
- Usage: wrap the display element.

```tsx
<InlineDatePicker value={task.deadline || ""} onCommit={(v) => update({ deadline: v })}>
  <span className="text-xs text-muted-foreground/70 tabular-nums">{dueLabel}</span>
</InlineDatePicker>
```

- Consumers: People profile "Met" field, Projects view rows (project due, milestone due, task deadline), TaskWidget deadline field.

### Checkboxes and check controls

- Boolean form fields use normal checkboxes.
- Completable object rows may use circular check controls.
- Checked rows may use muted text and strikethrough when completion is the primary semantic state.

### Tabs

Tabs are a secondary organization model. They separate views inside a known object or domain. They are not the primary way to surface a large object set.

#### Tab rules

- Use tabs for stable peer views.
- Do not use tabs to hide primary object discovery.
- Keep tab labels short.
- Do not nest tab systems unless there is no simpler hierarchy.

### Status indicators

Status is an icon language, not decoration.

```yaml
status:
  success: "CheckCircle2"
  attention: "AlertTriangle or OctagonAlert"
  active: "Activity, Play, or Loader2"
  paused: "Pause"
  neutral: "Circle or CircleDot"
```

- Color communicates function.
- Icons identify the kind of state.
- Text explains only when ambiguity remains.
- Selected failed states preserve failure color.

### Iconography

- Lucide is the icon set.
- Default inline size: `h-3.5 w-3.5`.
- Empty state icon size: `h-6 w-6`.
- Icons should be optically quiet. Do not use icons as illustration unless the surface is intentionally empty-state or onboarding.

### References

References are durable typed object links. They are part of the product's object graph, not decorative chips.

Canonical persisted grammar is `@type:id`.

Supported reference examples:

- `@person:abc`
- `@goal:123`
- `@task:456`
- `@project:789`
- `@page:design`
- `@pr:mantra-agent/mono/1928`

`@workflow:wf_123`

#### Reference rules

- Persist canonical `@type:id` references.
- Render references as compact typed links.
- Use the shared parser and renderer. Do not hard-code a narrow subset.
- Legacy forms may be accepted for migration, but new surfaces should emit canonical references.

### Scrollbars

Scrollbars are structural. They should indicate containment and scrollability without becoming visual chrome.

- Use stable scrollbar styling on dense containers.
- Avoid nested scroll regions unless they preserve a clear interaction boundary.
- Hidden scrollbars are allowed only when scrollability is otherwise obvious.

### Accessibility

- Interactive rows need keyboard affordances.
- Icon-only buttons need `aria-label`.
- Focus states must be visible.
- Color cannot be the only carrier of state.
- Dense UIs still need reachable hit targets.

## Interaction Principles

- Primary actions should be obvious, rare, and close to the object they affect.
- Object surfaces should preserve continuity: search, select, inspect, act.
- Prefer a compact object model over scattered panels.
- Progressive disclosure beats persistent clutter.
- Empty states must say what the surface is for and what to do next.

## Do / Don't

| Do | Don't |
|---|---|
| Use Hierarchy Tree for object surfacing | Default to loose lists for object sets |
| Use full-width canvases | Center page shells by habit |
| Use color as function | Use color as decoration |
| Use motion for continuity | Use motion as ornament |
| Use references as typed links | Render durable objects as plain text |
| Compose shared primitives | Invent local one-off widgets |

## Anti-patterns

Avoid these unless Ray explicitly chooses a local exception:

- Cards anywhere outside modal decision surfaces.
- Generic layout anatomy diagrams in production docs.
- Route, dashboard, settings, detail, or embedded-object UIs split across cards, tables, and loose lists instead of one coherent tree.
- `max-w-* mx-auto` on page shells.
- Non-canonical references.
- Hover-only actions with no keyboard path.
- Motion that delays the user's next action.

## LEGACY

This section preserves older guidance that existed in `DESIGN.md` but is not represented as active doctrine on the Design page. Do not use it as the default standard. Promote a legacy item back into active doctrine only after it is reconciled with the Design page.

### Legacy proportional guidance

φ may still be useful as a visual judgment aid for spacing relationships, especially when a surface feels mechanically even. It is not a required token scale.

### Legacy density guidance

Older docs defined explicit Comfortable, Default, and Compact density modes. The active standard is simpler: use compact density for object scanning, preserve readable gaps for sections, and do not create a separate density API unless the product needs runtime density switching.

### Legacy page archetypes

Older docs listed dashboard, focus workspace, tabbed index, command surface, detail/inspector, and stream/log archetypes. The Design page is now the source of truth. In particular, “tabbed-index is the dominant pattern” is retired. Hierarchy Tree is the primary object-surfacing modality.

### Legacy Simple Home guidance

Simple Home is a specific product surface, not general UI doctrine. Keep its rules near the Simple Home implementation or product spec, not in active design principles.

### Legacy lists guidance

Older docs contained detailed list row grammar. Loose lists are no longer a first-class primary pattern for object surfacing. Use Hierarchy Tree unless a simple static list is genuinely sufficient.

### Legacy stepped process guidance

Older docs contained a Stepped Process idiom. It is no longer active design doctrine. Workflow and process UIs should use the current product workflow components and status language rather than a standalone stepped-process pattern.

### Legacy forms, terminal/code, feedback, badges, and lifecycle guidance

Older docs included additional specific guidance for forms, terminal/code surfaces, component lifecycle, feedback hierarchy, loading selection, check controls, badges, and status markers. These are retained here as legacy coverage because the Design page does not currently expose them as active source-of-truth sections. Reintroduce only the parts that earn a visible Design page section.

### Legacy shadows and border radius

Border radius and shadow/depth are retired as standalone doctrine. Radius remains whatever the shared component primitives and Tailwind tokens already provide. Do not add a new radius or shadow scale.
