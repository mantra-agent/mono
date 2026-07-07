// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import type { ForwardedRef } from "react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useWikiLinks } from "@/hooks/use-wiki-links";
import { isEditorEmpty } from "@/lib/editor-utils";
import { tiptapToMarkdown as jsonToMarkdownShared, markdownToTiptap, isValidTiptapDoc } from "@shared/markdown-tiptap";
import { ReferenceWidgetExtension } from "@/components/references/tiptap-reference-extension";

const log = createLogger("RichTextEditor");

function jsonToMarkdown(node: JSONContent): string {
  return jsonToMarkdownShared(node);
}

function markdownToJson(md: string): JSONContent | null {
  if (!md.trim()) return null;
  return markdownToTiptap(md) as JSONContent;
}

export interface RichTextEditorHandle {
  insertContent: (content: string) => void;
}

interface RichTextEditorProps {
  value: JSONContent | null;
  onChange: (json: JSONContent, plainText: string) => void;
  placeholder?: string;
  className?: string;
  "data-testid"?: string;
  readOnly?: boolean;
  onInsertLink?: () => void;
  plainTextFallback?: string;
}

const EDITOR_INIT_TIMEOUT_MS = 5000;

async function uploadImageToBucket(file: File): Promise<string> {
  const urlRes = await fetch("/api/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
  });
  if (!urlRes.ok) throw new Error("Failed to get upload URL");
  const { uploadURL, objectPath } = (await urlRes.json()) as { uploadURL: string; objectPath: string };

  await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type || "image/jpeg" },
    body: file,
  });

  return objectPath;
}

export const RichTextEditor = forwardRef(function RichTextEditorInner(
  {
    value,
    onChange,
    placeholder = "Start writing...",
    className,
    "data-testid": testId,
    readOnly = false,
    onInsertLink,
    plainTextFallback,
  }: RichTextEditorProps,
  ref: ForwardedRef<RichTextEditorHandle>,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const plainTextFallbackRef = useRef(plainTextFallback);
  plainTextFallbackRef.current = plainTextFallback;
  const [initFailed, setInitFailed] = useState(false);

  const {
    wikiQuery,
    wikiPages,
    wikiSelectedIdx,
    wikiAnchor,
    WikiLinkExtension,
    insertWikiLink,
    onEditorUpdate,
    handleWikiKeyDown,
  } = useWikiLinks(editorContainerRef);

  const initialContent = isValidTiptapDoc(value) ? value : "";
  if (!isValidTiptapDoc(value)) {
    if (value) {
      log.warn("[LibraryContent] initialContent resolved to empty — value was present but not a valid TipTap doc", { valueType: typeof value, keys: Object.keys(value) });
    } else {
      log.debug("[LibraryContent] initialContent is null/empty, editor will show placeholder");
    }
  }

  const textToParagraphDoc = useCallback((text: string): JSONContent | null => {
    const paragraphs: JSONContent[] = text.split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => ({
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: line.replace(/^#+\s*/, "").replace(/^\s*[-*+]\s*/, "").replace(/^\s*\d+\.\s*/, "").replace(/[*_~`[\]]/g, "") }],
      }));
    return paragraphs.length > 0 ? { type: "doc", content: paragraphs } : null;
  }, []);

  const applyPlainTextFallback = useCallback((ed: { commands: { setContent: (content: JSONContent, options?: { emitUpdate?: boolean }) => boolean }; getJSON: () => JSONContent; state: { doc: { textContent: string } } }) => {
    const fallback = plainTextFallbackRef.current || "";
    if (!fallback.trim()) return;
    try {
      const converted = markdownToTiptap(fallback);
      ed.commands.setContent(converted, { emitUpdate: false });

      const afterJson = ed.getJSON();
      const afterText = ed.state.doc.textContent.trim();
      if (isEditorEmpty(afterJson) && !afterText) {
        log.warn("[LibraryContent] plain text fallback produced empty editor; applying last-resort paragraph fallback", { fallbackLength: fallback.length });
        const doc = textToParagraphDoc(fallback);
        if (doc) ed.commands.setContent(doc, { emitUpdate: false });
      } else {
        log.warn("[LibraryContent] plain text fallback applied successfully", { fallbackLength: fallback.length });
      }
    } catch (innerErr) {
      log.warn("[LibraryContent] plain text fallback failed; applying last-resort paragraphs", innerErr);
      try {
        const doc = textToParagraphDoc(fallback);
        if (doc) ed.commands.setContent(doc, { emitUpdate: false });
      } catch (lastResortErr) {
        log.error("[LibraryContent] last-resort paragraph fallback also failed", lastResortErr);
      }
    }
  }, [textToParagraphDoc]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      WikiLinkExtension,
      ReferenceWidgetExtension,
    ],
    content: initialContent,
    editable: !readOnly,
    onCreate: ({ editor: ed }) => {
      const incomingHasContent = isValidTiptapDoc(value);
      if (!incomingHasContent) return;

      const afterJson = ed.getJSON();
      const afterText = ed.state.doc.textContent.trim();
      if (isEditorEmpty(afterJson) && !afterText) {
        log.warn(
          "onCreate detected empty editor despite non-empty initial content, applying plain text fallback",
        );
        applyPlainTextFallback(ed);
      }
    },
    onUpdate: ({ editor: ed }) => {
      const json = ed.getJSON();
      const plainText = ed.getText();
      onChangeRef.current(json, plainText);
      onEditorUpdate(ed);
    },
  });

  const editorRef = useRef(editor);
  editorRef.current = editor;

  useImperativeHandle(ref, () => ({
    insertContent(content: string) {
      const ed = editorRef.current;
      if (!ed) return;
      ed.chain().focus().insertContent(content).run();
      const json = ed.getJSON();
      const plainText = ed.getText();
      onChangeRef.current(json, plainText);
    },
  }), []);

  useEffect(() => {
    if (editor) return;
    const timer = setTimeout(() => {
      if (!editorRef.current) {
        log.warn("editor failed to initialize within timeout");
        setInitFailed(true);
      }
    }, EDITOR_INIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    if (!value || Object.keys(value).length === 0) return;
    const currentJson = JSON.stringify(editor.getJSON());
    const incomingJson = JSON.stringify(value);
    if (currentJson !== incomingJson) {
      try {
        editor.commands.setContent(value, { emitUpdate: false });

        const afterSet = editor.getJSON();
        const afterText = editor.state.doc.textContent.trim();
        const incomingHasContent = isValidTiptapDoc(value);

        if (incomingHasContent && isEditorEmpty(afterSet) && !afterText) {
          log.warn(
            "setContent produced empty editor despite non-empty input, applying plain text fallback",
          );
          applyPlainTextFallback(editor);
        }
      } catch (err) {
        log.warn("setContent failed, falling back to plain text", err);
        applyPlainTextFallback(editor);
      }
    }
  }, [value, editor, applyPlainTextFallback]);

  const handleImagePasteOrDrop = useCallback(
    async (file: File) => {
      const ed = editorRef.current;
      if (!ed || readOnly) return;
      try {
        const src = await uploadImageToBucket(file);
        ed.chain().focus().setImage({ src }).run();
        const json = ed.getJSON();
        const plainText = ed.getText();
        onChangeRef.current(json, plainText);
      } catch {
        toastRef.current({ title: "Image upload failed", description: "Could not upload image. Please try again.", variant: "destructive" });
      }
    },
    [readOnly],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!editor || readOnly) return;
      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) handleImagePasteOrDrop(file);
        return;
      }
      const textItem = items.find(item => item.type === "text/plain");
      if (textItem) {
        textItem.getAsString((text) => {
          if (text.includes("| ") && text.includes("\n") && /^\|[\s\S]*\|$/.test(text.trim())) {
            e.preventDefault();
            const json = markdownToJson(text);
            if (json && json.content && json.content.length > 0) {
              editor.chain().focus().insertContent(json.content).run();
              const updatedJson = editor.getJSON();
              const plainText = editor.getText();
              onChangeRef.current(updatedJson, plainText);
            }
          }
        });
      }
    },
    [editor, readOnly, handleImagePasteOrDrop],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      if (!editor || readOnly) return;
      const files = Array.from(e.dataTransfer.files);
      const imageFile = files.find(f => f.type.startsWith("image/"));
      if (!imageFile) return;
      e.preventDefault();
      handleImagePasteOrDrop(imageFile);
    },
    [editor, readOnly, handleImagePasteOrDrop],
  );

  if (!editor) {
    if (initFailed) {
      return (
        <div className={cn("flex flex-col items-center justify-center h-full text-sm text-destructive gap-2", className)} data-testid={testId}>
          <span>Editor failed to initialize</span>
          <button
            type="button"
            className="text-xs underline text-muted-foreground hover:text-foreground"
            onClick={() => window.location.reload()}
            data-testid="button-editor-reload"
          >
            Reload page
          </button>
        </div>
      );
    }
    return (
      <div className={cn("flex items-center justify-center h-full text-sm text-muted-foreground", className)} data-testid={testId}>
        Loading editor...
      </div>
    );
  }

  return (
    <div
      ref={editorContainerRef}
      className={cn("flex flex-col h-full relative", className)}
      data-testid={testId}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => { if (!readOnly) e.preventDefault(); }}
      onKeyDown={(e) => handleWikiKeyDown(e, editor)}
    >
      {!readOnly && (
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/20 flex-wrap">
          <EditorButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            title="Bold"
          >
            <strong>B</strong>
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            title="Italic"
          >
            <em>I</em>
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            active={editor.isActive("strike")}
            title="Strikethrough"
          >
            <s>S</s>
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            active={editor.isActive("code")}
            title="Code"
          >
            {"<>"}
          </EditorButton>
          <div className="w-px h-4 bg-border mx-1" />
          <EditorButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            active={editor.isActive("heading", { level: 1 })}
            title="Heading 1"
          >
            H1
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive("heading", { level: 2 })}
            title="Heading 2"
          >
            H2
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            active={editor.isActive("heading", { level: 3 })}
            title="Heading 3"
          >
            H3
          </EditorButton>
          <div className="w-px h-4 bg-border mx-1" />
          <EditorButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive("bulletList")}
            title="Bullet List"
          >
            •—
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive("orderedList")}
            title="Ordered List"
          >
            1—
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            active={editor.isActive("blockquote")}
            title="Blockquote"
          >
            "
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            active={editor.isActive("codeBlock")}
            title="Code Block"
          >
            {"{}"}
          </EditorButton>
          <div className="w-px h-4 bg-border mx-1" />
          <EditorButton
            onClick={() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
            active={false}
            title="Insert Table"
          >
            ⊞
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().undo().run()}
            active={false}
            title="Undo"
          >
            ↩
          </EditorButton>
          <EditorButton
            onClick={() => editor.chain().focus().redo().run()}
            active={false}
            title="Redo"
          >
            ↪
          </EditorButton>
          <div className="w-px h-4 bg-border mx-1" />
          <EditorButton
            onClick={() => {
              const json = editor.getJSON();
              const md = jsonToMarkdown(json);
              navigator.clipboard.writeText(md).catch((err) => log.warn("clipboard write failed", err));
            }}
            active={false}
            title="Copy as Markdown"
          >
            MD
          </EditorButton>
          {onInsertLink && (
            <>
              <div className="w-px h-4 bg-border mx-1" />
              <EditorButton
                onClick={onInsertLink}
                active={false}
                title="Insert page link"
              >
                🔗
              </EditorButton>
            </>
          )}

        </div>
      )}
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto scrollbar-thin prose prose-sm dark:prose-invert max-w-none p-4 focus-visible:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_ul_ul]:my-0.5 [&_ol_ol]:my-0.5 [&_ul_ol]:my-0.5 [&_ol_ul]:my-0.5 [&_li>p]:my-0"
      />
      {wikiQuery !== null && wikiAnchor && (
        <div
          className="absolute z-50 bg-popover border border-border rounded-md shadow-md min-w-[200px] max-h-[240px] overflow-y-auto"
          style={{ top: wikiAnchor.top, left: wikiAnchor.left }}
          data-testid="wiki-link-popover"
        >
          {wikiPages.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {wikiQuery === "" ? "Type to search library pages..." : `No pages matching "${wikiQuery}"`}
            </div>
          ) : (
            wikiPages.map((page, idx) => (
              <button
                key={page.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); insertWikiLink(editor, page); }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors",
                  idx === Math.min(wikiSelectedIdx, wikiPages.length - 1) && "bg-accent"
                )}
                data-testid={`wiki-link-option-${page.id}`}
              >
                {page.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
});

function EditorButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active: boolean;
  title: string;
  children: React.ReactNode;
}) {
  const testId = `editor-btn-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      title={title}
      data-testid={testId}
      className={cn(
        "px-1.5 py-0.5 text-xs rounded transition-colors font-mono min-w-[22px] text-center",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
