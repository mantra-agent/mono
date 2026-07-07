// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/core";

const log = createLogger("WikiLinks");

export interface LibraryPageOption {
  id: string;
  title: string;
  slug: string;
}

export function useWikiLinks(editorContainerRef: React.RefObject<HTMLDivElement | null>) {
  const [wikiQuery, setWikiQuery] = useState<string | null>(null);
  const [wikiPages, setWikiPages] = useState<LibraryPageOption[]>([]);
  const [wikiSelectedIdx, setWikiSelectedIdx] = useState(0);
  const [wikiAnchor, setWikiAnchor] = useState<{ top: number; left: number } | null>(null);

  const wikiQueryRef = useRef<string | null>(null);
  wikiQueryRef.current = wikiQuery;
  const setWikiQueryRef = useRef(setWikiQuery);
  setWikiQueryRef.current = setWikiQuery;
  const setWikiSelectedIdxRef = useRef(setWikiSelectedIdx);
  setWikiSelectedIdxRef.current = setWikiSelectedIdx;
  const setWikiAnchorRef = useRef(setWikiAnchor);
  setWikiAnchorRef.current = setWikiAnchor;

  const WikiLinkExtension = useMemo(
    () =>
      Extension.create({
        name: "wikiLink",
        addKeyboardShortcuts() {
          return {
            "[": ({ editor }) => {
              const { from } = editor.state.selection;
              const precedingChar = editor.state.doc.textBetween(
                Math.max(0, from - 1),
                from,
              );
              if (precedingChar === "[") {
                setWikiQueryRef.current("");
                setWikiSelectedIdxRef.current(0);
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                  const range = sel.getRangeAt(0);
                  const rect = range.getBoundingClientRect();
                  const containerRect =
                    editorContainerRef.current?.getBoundingClientRect();
                  if (containerRect) {
                    setWikiAnchorRef.current({
                      top: rect.bottom - containerRect.top + 4,
                      left: rect.left - containerRect.left,
                    });
                  }
                }
              }
              return false;
            },
            Escape: () => {
              if (wikiQueryRef.current !== null) {
                setWikiQueryRef.current(null);
                setWikiAnchorRef.current(null);
                return true;
              }
              return false;
            },
            ArrowDown: () => {
              if (wikiQueryRef.current !== null) {
                setWikiSelectedIdxRef.current((i) => i + 1);
                return true;
              }
              return false;
            },
            ArrowUp: () => {
              if (wikiQueryRef.current !== null) {
                setWikiSelectedIdxRef.current((i) => Math.max(0, i - 1));
                return true;
              }
              return false;
            },
            Enter: () => {
              if (wikiQueryRef.current !== null) {
                return true;
              }
              return false;
            },
          };
        },
      }),
    [],
  );

  useEffect(() => {
    if (wikiQuery === null) return;
    const q = wikiQuery;
    const timer = setTimeout(() => {
      fetch(`/api/info/library?search=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((pages: LibraryPageOption[]) => {
          setWikiPages(pages.slice(0, 8));
          setWikiSelectedIdx(0);
        })
        .catch((err) => {
          log.warn("failed to fetch pages", err);
          setWikiPages([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [wikiQuery]);

  const insertWikiLink = useCallback((editor: Editor, page: LibraryPageOption) => {
    const { from } = editor.state.selection;
    const text = editor.state.doc.textBetween(Math.max(0, from - 40), from);
    const match = text.match(/\[\[([^\]]*?)$/);
    if (match) {
      const deleteFrom = from - match[0].length;
      editor
        .chain()
        .focus()
        .deleteRange({ from: deleteFrom, to: from })
        .insertContent(`[[${page.title}]]`)
        .run();
    }
    setWikiQuery(null);
    setWikiAnchor(null);
  }, []);

  const onEditorUpdate = useCallback((editor: Editor) => {
    if (wikiQueryRef.current !== null) {
      const { from } = editor.state.selection;
      const text = editor.state.doc.textBetween(Math.max(0, from - 40), from);
      const match = text.match(/\[\[([^\]]*?)$/);
      if (match) {
        setWikiQuery(match[1]);
      } else {
        setWikiQuery(null);
        setWikiAnchor(null);
      }
    }
  }, []);

  const handleWikiKeyDown = useCallback(
    (e: React.KeyboardEvent, editor: Editor | null) => {
      if (wikiQuery === null || !editor) return;
      if (e.key === "Enter") {
        e.preventDefault();
        const idx = Math.min(wikiSelectedIdx, wikiPages.length - 1);
        if (wikiPages[idx]) insertWikiLink(editor, wikiPages[idx]);
      }
    },
    [wikiQuery, wikiSelectedIdx, wikiPages, insertWikiLink],
  );

  return {
    wikiQuery,
    wikiPages,
    wikiSelectedIdx,
    wikiAnchor,
    WikiLinkExtension,
    insertWikiLink,
    onEditorUpdate,
    handleWikiKeyDown,
  };
}
