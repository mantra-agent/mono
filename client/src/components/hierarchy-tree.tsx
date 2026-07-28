import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Match the Project task tree geometry. Derive the connector from row padding
// and completion-control size so the branch terminates at the center of the check.
const ROW_PADDING_PX = 8;
const COMPLETION_SIZE_PX = 16;
const CONNECTOR_STROKE_PX = 1;
const INDENT_STEP_PX = 24;
const CONNECTOR_SPINE_PX = INDENT_STEP_PX - ROW_PADDING_PX - COMPLETION_SIZE_PX / 2;
const CONNECTOR_BRANCH_PX = ROW_PADDING_PX + COMPLETION_SIZE_PX / 2 - CONNECTOR_SPINE_PX;

type HierarchyTreeConnectorAnchor = "content-center" | "first-row-center";

const FIRST_ROW_CENTER_PX = 16;

function HierarchyTreeConnector({
  continues,
  anchor,
}: {
  continues: boolean;
  anchor: HierarchyTreeConnectorAnchor;
}) {
  const anchorPosition = anchor === "first-row-center" ? `${FIRST_ROW_CENTER_PX}px` : "50%";
  const spineStyle = {
    left: CONNECTOR_SPINE_PX,
    width: CONNECTOR_STROKE_PX,
    ...(continues ? { bottom: 0 } : { bottom: `calc(100% - ${anchorPosition})` }),
  };
  const branchStyle = {
    left: CONNECTOR_SPINE_PX,
    top: anchorPosition,
    width: CONNECTOR_BRANCH_PX,
    height: CONNECTOR_STROKE_PX,
  };

  return (
    <div className="relative w-4 shrink-0 self-stretch" aria-hidden="true">
      <div className="absolute top-0 bg-border" style={spineStyle} />
      <div className="absolute bg-border" style={branchStyle} />
    </div>
  );
}

export function HierarchyTreeRow({
  continues,
  connectorAnchor = "content-center",
  children,
}: {
  continues: boolean;
  connectorAnchor?: HierarchyTreeConnectorAnchor;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 items-stretch"
      style={{ paddingLeft: INDENT_STEP_PX }}
    >
      <HierarchyTreeConnector continues={continues} anchor={connectorAnchor} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
