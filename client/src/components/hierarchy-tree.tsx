import type { ReactNode } from "react";

// Match the Project task tree geometry. Derive the connector from row padding
// and completion-control size so the branch terminates at the center of the check.
const ROW_PADDING_PX = 8;
const COMPLETION_SIZE_PX = 16;
const ICON_SIZE_PX = 14;
const CONNECTOR_STROKE_PX = 1;
const INDENT_STEP_PX = 24;
const DEFAULT_SPINE_PX = INDENT_STEP_PX - ROW_PADDING_PX - COMPLETION_SIZE_PX / 2;
const DEFAULT_BRANCH_PX = ROW_PADDING_PX + COMPLETION_SIZE_PX / 2 - DEFAULT_SPINE_PX;
const ICON_CENTER_PX = ROW_PADDING_PX + ICON_SIZE_PX / 2;
const ICON_BRANCH_PX = 8;

type HierarchyTreeConnectorAnchor = "content-center" | "first-row-center";
type HierarchyTreeIndent = "default" | "icon";

const FIRST_ROW_CENTER_PX = 16;

function HierarchyTreeConnector({
  continues,
  anchor,
  spinePx,
  branchPx,
  widthPx,
}: {
  continues: boolean;
  anchor: HierarchyTreeConnectorAnchor;
  spinePx: number;
  branchPx: number;
  widthPx: number;
}) {
  const anchorPosition = anchor === "first-row-center" ? `${FIRST_ROW_CENTER_PX}px` : "50%";
  const spineStyle = {
    left: spinePx,
    width: CONNECTOR_STROKE_PX,
    ...(continues ? { bottom: 0 } : { bottom: `calc(100% - ${anchorPosition})` }),
  };
  const branchStyle = {
    left: spinePx,
    top: anchorPosition,
    width: branchPx,
    height: CONNECTOR_STROKE_PX,
  };

  return (
    <div className="relative shrink-0 self-stretch" style={{ width: widthPx }} aria-hidden="true">
      <div className="absolute top-0 bg-border" style={spineStyle} />
      <div className="absolute bg-border" style={branchStyle} />
    </div>
  );
}

export function HierarchyTreeRow({
  continues,
  connectorAnchor = "content-center",
  indent = "default",
  children,
}: {
  continues: boolean;
  connectorAnchor?: HierarchyTreeConnectorAnchor;
  /** `icon` aligns the L spine to a ProfileTreeRow parent icon (`px-2` + `h-3.5`). */
  indent?: HierarchyTreeIndent;
  children: ReactNode;
}) {
  const iconIndent = indent === "icon";
  return (
    <div
      className="flex min-w-0 items-stretch"
      style={iconIndent ? undefined : { paddingLeft: INDENT_STEP_PX }}
    >
      <HierarchyTreeConnector
        continues={continues}
        anchor={connectorAnchor}
        spinePx={iconIndent ? ICON_CENTER_PX : DEFAULT_SPINE_PX}
        branchPx={iconIndent ? ICON_BRANCH_PX : DEFAULT_BRANCH_PX}
        widthPx={iconIndent ? ICON_CENTER_PX + ICON_BRANCH_PX : 16}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
