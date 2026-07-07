import type { JSONContent } from "@tiptap/core";
import { tiptapToMarkdown } from "@shared/markdown-tiptap";

export function isEditorEmpty(json: JSONContent): boolean {
  return (
    !json.content ||
    json.content.length === 0 ||
    (json.content.length === 1 &&
      json.content[0].type === "paragraph" &&
      !json.content[0].content)
  );
}

export function downloadPageAsMarkdown(
  title: string,
  content: JSONContent | null,
  plainTextContent?: string,
): void {
  const md = content ? tiptapToMarkdown(content) : plainTextContent || "";
  const slug =
    (title || "page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "page";
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
