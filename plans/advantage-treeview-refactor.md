# Advantage Treeview Refactor

## Goal

Refactor `/business/advantage` from card-based dashboard layout to the canonical Hierarchy Tree while preserving its operating-cycle, goal hierarchy, scorecard, source, freshness, and error-state semantics. Update `DESIGN.md` and the Build Design page so page UIs use the Hierarchy Tree and the Card primitive is reserved for modal decision surfaces.

## Implementation

1. Replace Advantage `Card` containers with canonical `ProfileTreeRow`, `HierarchyTreeRow`, and `HierarchySectionHeader` composition.
2. Render the thematic goal, defining objectives, operating-health domains, and measures as progressively disclosed tree branches; keep statuses, owners, targets, cadence, definitions, source, freshness, and instrumentation visible in the hierarchy.
3. Keep loading and failure states on the page canvas without card shells.
4. Replace stale card doctrine in `DESIGN.md` and the Build Design page with the modal-only Card invariant and explicit tree-first page guidance.

## Engineering Principles Check

- **Single source of truth / DRY:** reuse the existing Advantage model and canonical tree primitives; do not duplicate data or invent another hierarchy component.
- **Interfaces before implementation:** preserve `AdvantageOperatingCycle` and API contracts; this is a presentation-only migration.
- **Progressive disclosure:** objectives, domains, and measures expand in place rather than spreading detail across cards.
- **Design from the user backward:** preserve scanability and provenance while moving to the product-wide tree grammar.
- **Smallest coherent fix:** touch only the Advantage renderer and the two canonical design-doctrine surfaces.
- **No cured violations beyond scope:** the plan removes local card-as-page-layout duplication and prevents the docs from authorizing future card-based pages; it does not attempt a repository-wide legacy-card migration.

## Verification

Run `npm run build`, inspect the final diff and change scope, then ship through a PR to `main`.
