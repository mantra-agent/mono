import type { JSONContent } from "@tiptap/core";
import { BookOpen, List, FolderOpen } from "lucide-react";

export interface LibraryPage {
  id: string;
  pageId: number;
  title: string;
  slug: string;
  content?: JSONContent | null;
  plainTextContent?: string;
  parentId: string | null;
  tags: string[];
  scope?: string;
  surface?: boolean;
  surfaceUntil?: string | null;
  surfaceReason?: string | null;
  surfaceSection?: string | null;

  emoji: string | null;
  oneLiner: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPageFull extends LibraryPage {
  content: JSONContent | null;
  plainTextContent: string;
}

export interface LibraryAnnotation {
  id: string;
  pageId: string;
  content: string;
  annotationType: "observation" | "connection" | "confidence";
  createdAt: string;
}

export interface TreeNode extends LibraryPage {
  children: TreeNode[];
}

export interface ScratchFile {
  path: string;
  size: number;
  mtime: string;
}

export interface BucketFile {
  name: string;
  size: number;
  contentType: string;
  updated: string;
  downloadUrl: string;
}

export interface FlatNode {
  id: string;
  node: TreeNode;
  depth: number;
  parentId: string | null;
  index: number;
}

export type DropPosition = "above" | "below" | "inside";

export const INFO_TABS = [
  { value: "library", label: "Library", icon: <BookOpen className="h-3.5 w-3.5" />, testId: "tab-info-library" },
  { value: "index", label: "Index", icon: <List className="h-3.5 w-3.5" />, testId: "tab-info-index" },
  { value: "files", label: "Files", icon: <FolderOpen className="h-3.5 w-3.5" />, testId: "tab-info-files" },
];

export const VISIBLE_INFO_TABS = INFO_TABS.filter((tab) => tab.value === "library");

export const VALID_TABS = ["library", "index", "files"] as const;
export type InfoTab = typeof VALID_TABS[number];


