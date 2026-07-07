import { useCallback, useMemo } from "react";
import {
  DndContext, closestCenter, PointerSensor, TouchSensor, useSensor, useSensors,
  type DragStartEvent, type DragEndEvent, type DragOverEvent,
  DragOverlay,
} from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Trash2, FileText, ChevronRight, Globe,
  Download, FilePlus, MoreHorizontal, Sparkles, FolderInput,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { TreeNode, FlatNode, DropPosition } from "./types";
import { PageEmoji } from "./library-components";

const MAX_INDENT_PX = 96;
const INDENT_STEP_PX = 16;

export function flattenTree(nodes: TreeNode[], depth: number, parentId: string | null, expanded: Set<string>): FlatNode[] {
  const result: FlatNode[] = [];
  nodes.forEach((node, index) => {
    result.push({ id: node.id, node, depth, parentId, index });
    if (expanded.has(node.id) && node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1, node.id, expanded));
    }
  });
  return result;
}

export function isDescendant(tree: TreeNode[], parentId: string, childId: string): boolean {
  const find = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.id === parentId) return n;
      const found = find(n.children);
      if (found) return found;
    }
    return undefined;
  };
  const parent = find(tree);
  if (!parent) return false;
  const check = (nodes: TreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === childId) return true;
      if (check(n.children)) return true;
    }
    return false;
  };
  return check(parent.children);
}

export function DraggableTreeNode({ flatNode, selectedId, onSelect, onCreateChild, onSetEmoji, onDelete, onDownload, onEnrich, onMove, dropTarget, expandedSet, toggleExpand, unreadIds, hasUnreadDescendantIds }: {
  flatNode: FlatNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onSetEmoji: (id: string, emoji: string | null) => void;
  onDelete: (id: string) => void;
  onDownload: (node: TreeNode) => void;
  onEnrich: (id: string) => void;
  onMove: (id: string) => void;
  dropTarget: { id: string; position: DropPosition } | null;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
  unreadIds?: Set<string>;
  hasUnreadDescendantIds?: Set<string>;
}) {
  const { node, depth } = flatNode;
  const hasChildren = node.children.length > 0;
  const isExpandable = hasChildren;
  const isExpanded = expandedSet.has(node.id);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id });

  const style = {
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const isDropTarget = dropTarget?.id === node.id;
  const dropPos = dropTarget?.position;
  const isSelected = selectedId === node.id;
  const isUnread = unreadIds?.has(node.id) ?? false;
  const hasUnreadDescendant = !isUnread && (hasUnreadDescendantIds?.has(node.id) ?? false);
  const indentPx = Math.min(depth * INDENT_STEP_PX, MAX_INDENT_PX);
  const pageTooltip = node.oneLiner || node.summary || undefined;

  return (
    <div ref={setNodeRef} style={style} className="min-w-0">
      {isDropTarget && dropPos === "above" && (
        <div className="h-px rounded bg-border" style={{ marginLeft: indentPx + (depth > 0 ? 24 : 0) }} />
      )}
      <div className="flex w-full min-w-0 max-w-full items-stretch overflow-hidden">
        {indentPx > 0 && <div className="shrink-0" style={{ width: indentPx }} aria-hidden="true" />}
        {depth > 0 && (
          <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
            <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border" />
            <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
          </div>
        )}
        <div className="min-w-0 max-w-full flex-1 overflow-hidden">
          <div
            className={cn(
              "group relative flex w-full min-w-0 max-w-full cursor-grab items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-sm transition-colors active:cursor-grabbing",
              isSelected ? "bg-accent text-foreground" : "bg-transparent text-foreground hover:bg-accent/50",
              isDropTarget && dropPos === "inside" && "ring-2 ring-ring ring-inset bg-accent"
            )}
            {...attributes}
            {...listeners}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid={`button-library-page-${node.id}`}
                  onClick={() => onSelect(node.id)}
                  className="flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden pr-14 text-left text-sm focus-visible:outline-none"
                  aria-label={node.title || "Untitled"}
                >
                  <span className={cn(
                    "relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground",
                    isSelected && "text-foreground",
                    isUnread && !isSelected && "text-foreground",
                  )}>
                    <PageEmoji emoji={node.emoji} size="xs" />
                  </span>
                  <span className={cn(
                    "min-w-0 flex-1 truncate pr-6 text-sm",
                    isUnread ? "font-medium text-foreground" : "font-normal",
                    hasUnreadDescendant && "font-medium text-muted-foreground",
                  )}>
                    {node.title || "Untitled"}
                  </span>
                  {node.scope === "shared" && (
                    <Globe className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Shared with all users" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" align="start" className="max-w-xs">
                {pageTooltip || node.title || "Untitled"}
              </TooltipContent>
            </Tooltip>
            <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 shrink-0 items-center gap-1">
              {isExpandable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(node.id);
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded border border-transparent text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={isExpanded ? "Collapse pages" : "Expand pages"}
                      data-testid={`button-tree-twisty-${node.id}`}
                    >
                      <ChevronRight className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-90")} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{isExpanded ? "Collapse" : "Expand"}</TooltipContent>
                </Tooltip>
              )}
              <DropdownMenu modal={false}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "flex h-6 w-6 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                          isSelected && "bg-accent text-foreground",
                        )}
                        data-testid={`button-tree-menu-${node.id}`}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Page actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <DropdownMenuItem onClick={() => onCreateChild(node.id)} data-testid={`menu-tree-add-page-${node.id}`}>
                    <FilePlus className="h-3.5 w-3.5 mr-2" /> Add Page
                  </DropdownMenuItem>
                  {node.emoji && (
                    <DropdownMenuItem onClick={() => onSetEmoji(node.id, null)} data-testid={`menu-tree-remove-icon-${node.id}`}>
                      <FileText className="h-3.5 w-3.5 mr-2" /> Remove Icon
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => onEnrich(node.id)} data-testid={`menu-tree-enrich-${node.id}`}>
                    <Sparkles className="h-3.5 w-3.5 mr-2" /> Enrich
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onMove(node.id)} data-testid={`menu-tree-move-${node.id}`}>
                    <FolderInput className="h-3.5 w-3.5 mr-2" /> Move
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDownload(node)}
                    data-testid={`menu-tree-download-${node.id}`}
                  >
                    <Download className="h-3.5 w-3.5 mr-2" /> Download
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onDelete(node.id)}
                    className="text-destructive"
                    data-testid={`menu-tree-delete-${node.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>
      {isDropTarget && dropPos === "below" && (
        <div className="h-px rounded bg-border" style={{ marginLeft: indentPx + (depth > 0 ? 24 : 0) }} />
      )}
    </div>
  );
}

function DragOverlayContent({ node }: { node: TreeNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 text-sm text-foreground shadow-sm">
      <PageEmoji emoji={node.emoji} size="xs" />
      <span className="truncate">{node.title || "Untitled"}</span>
    </div>
  );
}

interface DndTreeProps {
  treeData: TreeNode[];
  flatNodes: FlatNode[];
  flatNodeIds: string[];
  flatNodeMap: Map<string, FlatNode>;
  selectedId: string | null;
  expandedIds: Set<string>;
  dragActiveId: string | null;
  dropTarget: { id: string; position: DropPosition } | null;
  onDragActiveIdChange: (id: string | null) => void;
  onDropTargetChange: (target: { id: string; position: DropPosition } | null) => void;
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onSetEmoji: (id: string, emoji: string | null) => void;
  onDelete: (id: string) => void;
  onDownload: (node: TreeNode) => void;
  onEnrich: (id: string) => void;
  onMove: (id: string) => void;
  onReorder: (data: { id: string; parentId: string | null; sortOrder: number }) => void;
  toggleExpand: (id: string) => void;
  unreadIds?: Set<string>;
  hasUnreadDescendantIds?: Set<string>;
}

export function DndTree({
  treeData, flatNodes, flatNodeIds, flatNodeMap, selectedId,
  expandedIds, dragActiveId, dropTarget,
  onDragActiveIdChange, onDropTargetChange,
  onSelect, onCreateChild, onSetEmoji, onDelete, onDownload, onEnrich, onMove, onReorder, toggleExpand,
  unreadIds,
  hasUnreadDescendantIds,
}: DndTreeProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    onDragActiveIdChange(event.active.id as string);
  }, [onDragActiveIdChange]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      onDropTargetChange(null);
      return;
    }
    const overNode = flatNodeMap.get(over.id as string);
    if (!overNode) { onDropTargetChange(null); return; }

    const overRect = over.rect;
    let startY = 0;
    const activator = event.activatorEvent;
    if (activator instanceof MouseEvent) {
      startY = activator.clientY;
    } else if (typeof TouchEvent !== "undefined" && activator instanceof TouchEvent) {
      startY = activator.touches?.[0]?.clientY ?? activator.changedTouches?.[0]?.clientY ?? 0;
    }
    const delta = event.delta?.y ?? 0;
    const currentY = startY + delta;
    const relativeY = currentY - overRect.top;
    const height = overRect.height || 28;
    const ratio = Math.max(0, Math.min(1, relativeY / height));

    let position: DropPosition;
    if (ratio < 0.25) position = "above";
    else if (ratio > 0.75) position = "below";
    else position = "inside";

    if (isDescendant(treeData, active.id as string, over.id as string)) {
      onDropTargetChange(null);
      return;
    }

    onDropTargetChange({ id: over.id as string, position });
  }, [flatNodeMap, treeData, onDropTargetChange]);

  const handleDragEnd = useCallback(() => {
    const activeId = dragActiveId;
    onDragActiveIdChange(null);
    const currentDropTarget = dropTarget;
    onDropTargetChange(null);

    if (!activeId || !currentDropTarget) return;
    const targetNode = flatNodeMap.get(currentDropTarget.id);
    if (!targetNode) return;

    let newParentId: string | null;
    let newSortOrder: number;

    if (currentDropTarget.position === "inside") {
      newParentId = currentDropTarget.id;
      newSortOrder = targetNode.node.children.length;
    } else if (currentDropTarget.position === "above") {
      newParentId = targetNode.parentId;
      newSortOrder = targetNode.index;
    } else {
      newParentId = targetNode.parentId;
      newSortOrder = targetNode.index + 1;
    }

    const activeNode = flatNodeMap.get(activeId);
    if (activeNode && activeNode.parentId === newParentId) {
      if (newSortOrder > activeNode.index) newSortOrder -= 1;
      if (newSortOrder === activeNode.index) return;
    }

    onReorder({ id: activeId, parentId: newParentId, sortOrder: newSortOrder });
  }, [dragActiveId, dropTarget, flatNodeMap, onDragActiveIdChange, onDropTargetChange, onReorder]);

  const handleDragCancel = useCallback(() => {
    onDragActiveIdChange(null);
    onDropTargetChange(null);
  }, [onDragActiveIdChange, onDropTargetChange]);

  const draggedNode = dragActiveId ? flatNodeMap.get(dragActiveId)?.node : null;

  return (
    <TooltipProvider delayDuration={250}>
    <div className="w-full min-w-0 max-w-full overflow-hidden">
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={flatNodeIds} strategy={verticalListSortingStrategy}>
        {flatNodes.map(flatNode => (
          <DraggableTreeNode
            key={flatNode.id}
            flatNode={flatNode}
            selectedId={selectedId}
            onSelect={onSelect}
            onCreateChild={onCreateChild}
            onSetEmoji={onSetEmoji}
            onDelete={onDelete}
            onDownload={onDownload}
            onEnrich={onEnrich}
            onMove={onMove}
            dropTarget={dropTarget}
            expandedSet={expandedIds}
            toggleExpand={toggleExpand}
            unreadIds={unreadIds}
            hasUnreadDescendantIds={hasUnreadDescendantIds}
          />
        ))}
      </SortableContext>
      <DragOverlay>
        {draggedNode ? <DragOverlayContent node={draggedNode} /> : null}
      </DragOverlay>
    </DndContext>
    </div>
    </TooltipProvider>
  );
}
