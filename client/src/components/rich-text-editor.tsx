// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import type { ForwardedRef, MutableRefObject, ReactNode } from "react";
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

type EditorMenuAnchor = { top: number; left: number };
type EditorMenuSource = "slash" | "handle";

type EditorCommand = {
  id: string;
  label: string;
  hint: string;
  shortcut?: string;
  icon: ReactNode;
  isActive?: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
};

function emitEditorChange(editor: Editor, onChangeRef: MutableRefObject<(json: JSONContent, plainText: string) => void>) {
  onChangeRef.current(editor.getJSON(), editor.getText());
}

function deleteSlashTrigger(editor: Editor, fromPos: number | null) {
  const { from } = editor.state.selection;
  if (fromPos !== null && fromPos >= 0 && from >= fromPos) {
    editor.commands.deleteRange({ from: fromPos, to: from });
    return;
  }
  if (from <= 0) return;
  const previous = editor.state.doc.textBetween(from - 1, from, "", "");
  if (previous === "/") editor.commands.deleteRange({ from: from - 1, to: from });
}

function buildEditorCommands(onInsertLink?: () => void): EditorCommand[] {
  const commands: EditorCommand[] = [
    { id: "paragraph", label: "Text", hint: "Plain text block", icon: "T", isActive: (editor) => editor.isActive("paragraph"), run: (editor) => editor.chain().focus().setParagraph().run() },
    { id: "heading-1", label: "Heading 1", hint: "Large section heading", shortcut: "#", icon: "H1", isActive: (editor) => editor.isActive("heading", { level: 1 }), run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { id: "heading-2", label: "Heading 2", hint: "Medium section heading", shortcut: "##", icon: "H2", isActive: (editor) => editor.isActive("heading", { level: 2 }), run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: "heading-3", label: "Heading 3", hint: "Small section heading", shortcut: "###", icon: "H3", isActive: (editor) => editor.isActive("heading", { level: 3 }), run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { id: "bullet-list", label: "Bullet list", hint: "Create a simple list", shortcut: "-", icon: "•", isActive: (editor) => editor.isActive("bulletList"), run: (editor) => editor.chain().focus().toggleBulletList().run() },
    { id: "ordered-list", label: "Numbered list", hint: "Create an ordered list", shortcut: "1.", icon: "1", isActive: (editor) => editor.isActive("orderedList"), run: (editor) => editor.chain().focus().toggleOrderedList().run() },
    { id: "quote", label: "Quote", hint: "Capture quoted text", shortcut: ">", icon: "“", isActive: (editor) => editor.isActive("blockquote"), run: (editor) => editor.chain().focus().toggleBlockquote().run() },
    { id: "code-block", label: "Code block", hint: "Insert a code block", shortcut: "```", icon: "{}", isActive: (editor) => editor.isActive("codeBlock"), run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
    { id: "divider", label: "Divider", hint: "Separate sections", shortcut: "---", icon: "—", run: (editor) => editor.chain().focus().setHorizontalRule().run() },
    { id: "table", label: "Table", hint: "3 × 3 table with header", icon: "⊞", run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "bold", label: "Bold", hint: "Emphasize selected text", shortcut: "⌘B", icon: <strong>B</strong>, isActive: (editor) => editor.isActive("bold"), run: (editor) => editor.chain().focus().toggleBold().run() },
    { id: "italic", label: "Italic", hint: "Italicize selected text", shortcut: "⌘I", icon: <em>I</em>, isActive: (editor) => editor.isActive("italic"), run: (editor) => editor.chain().focus().toggleItalic().run() },
    { id: "strike", label: "Strikethrough", hint: "Cross out selected text", icon: <s>S</s>, isActive: (editor) => editor.isActive("strike"), run: (editor) => editor.chain().focus().toggleStrike().run() },
    { id: "inline-code", label: "Inline code", hint: "Format selected text as code", icon: "<>", isActive: (editor) => editor.isActive("code"), run: (editor) => editor.chain().focus().toggleCode().run() },
    { id: "undo", label: "Undo", hint: "Undo last edit", shortcut: "⌘Z", icon: "↩", run: (editor) => editor.chain().focus().undo().run() },
    { id: "redo", label: "Redo", hint: "Redo last edit", shortcut: "⇧⌘Z", icon: "↪", run: (editor) => editor.chain().focus().redo().run() },
    { id: "copy-markdown", label: "Copy as Markdown", hint: "Copy page body as Markdown", icon: "MD", run: (editor) => { const md = jsonToMarkdown(editor.getJSON()); navigator.clipboard.writeText(md).catch((err) => log.warn("clipboard write failed", err)); } },
  ];
  if (onInsertLink) {
    commands.push({ id: "page-link", label: "Page link", hint: "Insert a Library page link", icon: "🔗", run: () => onInsertLink() });
  }
  return commands;
}


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

  const [menuAnchor, setMenuAnchor] = useState<EditorMenuAnchor | null>(null);
  const [menuSource, setMenuSource] = useState<EditorMenuSource>("slash");
  const slashTriggerFromRef = useRef<number | null>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIdx, setSelectedCommandIdx] = useState(0);
  const commands = buildEditorCommands(onInsertLink);
  const filteredCommands = commands.filter((command) => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return true;
    return command.label.toLowerCase().includes(q) || command.hint.toLowerCase().includes(q) || command.id.includes(q);
  });

  const closeCommandMenu = useCallback(() => {
    setMenuAnchor(null);
    slashTriggerFromRef.current = null;
    setCommandQuery("");
    setSelectedCommandIdx(0);
  }, []);

  const openCommandMenuAtSelection = useCallback((source: EditorMenuSource) => {
    const ed = editorRef.current;
    const container = editorContainerRef.current;
    if (!ed || !container || readOnly) return;
    const coords = ed.view.coordsAtPos(ed.state.selection.from);
    const box = container.getBoundingClientRect();
    setMenuSource(source);
    slashTriggerFromRef.current = source === "slash" ? Math.max(0, ed.state.selection.from - 1) : null;
    setMenuAnchor({ top: coords.bottom - box.top + 6, left: Math.max(8, coords.left - box.left) });
    setCommandQuery("");
    setSelectedCommandIdx(0);
  }, [readOnly]);

  const runCommand = useCallback((command: EditorCommand) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (menuSource === "slash") deleteSlashTrigger(ed, slashTriggerFromRef.current);
    command.run(ed);
    emitEditorChange(ed, onChangeRef);
    closeCommandMenu();
  }, [closeCommandMenu, menuSource]);

  useEffect(() => {
    setSelectedCommandIdx(0);
  }, [commandQuery]);

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
      className={cn("group flex flex-col h-full relative", className)}
      data-testid={testId}
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={(e) => { if (!readOnly) e.preventDefault(); }}
      onKeyDown={(e) => {
        if (menuAnchor) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedCommandIdx((idx) => Math.min(idx + 1, Math.max(filteredCommands.length - 1, 0)));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedCommandIdx((idx) => Math.max(idx - 1, 0));
            return;
          }
          if (e.key === "Enter") {
            const command = filteredCommands[selectedCommandIdx];
            if (command) {
              e.preventDefault();
              runCommand(command);
            }
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            closeCommandMenu();
            return;
          }
          if (menuSource === "slash" && e.key === "Backspace" && commandQuery.length > 0) {
            setCommandQuery((q) => q.slice(0, -1));
          } else if (menuSource === "slash" && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            setCommandQuery((q) => `${q}${e.key}`);
          }
        } else if (!readOnly && e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          window.requestAnimationFrame(() => openCommandMenuAtSelection("slash"));
        }
        handleWikiKeyDown(e, editor);
      }}
    >
      {!readOnly && (
        <button
          type="button"
          className="absolute left-1 top-16 z-20 hidden h-7 w-7 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 md:flex"
          onMouseDown={(e) => { e.preventDefault(); openCommandMenuAtSelection("handle"); }}
          title="Open block menu"
          data-testid="button-editor-block-menu"
        >
          ⋮⋮
        </button>
      )}
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto scrollbar-thin prose prose-sm dark:prose-invert max-w-none px-10 py-4 focus-visible:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_ul_ul]:my-0.5 [&_ol_ol]:my-0.5 [&_ul_ol]:my-0.5 [&_ol_ul]:my-0.5 [&_li>p]:my-0"
      />
      {menuAnchor && !readOnly && (
        <div
          className="absolute z-50 w-72 max-w-[calc(100%-1rem)] overflow-hidden rounded-md border border-border bg-popover shadow-md"
          style={{ top: menuAnchor.top, left: menuAnchor.left }}
          data-testid="editor-command-menu"
        >
          <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            {menuSource === "slash" ? `/${commandQuery}` : "Block commands"}
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {filteredCommands.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No commands</div>
            ) : filteredCommands.map((command, idx) => (
              <button
                key={command.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
                  idx === selectedCommandIdx ? "bg-accent text-accent-foreground" : "hover:bg-accent/70",
                )}
                onMouseDown={(e) => { e.preventDefault(); runCommand(command); }}
                data-testid={`editor-command-${command.id}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/70 bg-muted/40 text-xs font-medium">{command.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{command.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{command.hint}</span>
                </span>
                {command.shortcut && <span className="text-[10px] text-muted-foreground">{command.shortcut}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
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
