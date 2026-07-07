import { createLogger } from "@/lib/logger";
import { useState, useRef, useCallback, useEffect } from "react";
import type { JSONContent } from "@tiptap/core";
import type { UseMutationResult } from "@tanstack/react-query";

const log = createLogger("useEditableContent");

interface UseEditableContentOptions {
  selectedId: string | null;
  initialTitle: string;
  initialContent: JSONContent | null;
  initialPlainText: string;
  saveMutation: UseMutationResult<
    unknown,
    Error,
    { id: string; title: string; content: JSONContent | null; plainTextContent: string }
  >;
  debounceMs?: number;
}

export function useEditableContent({
  selectedId,
  initialTitle,
  initialContent,
  initialPlainText,
  saveMutation,
  debounceMs = 1500,
}: UseEditableContentOptions) {
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState<JSONContent | null>(null);
  const [editPlainText, setEditPlainText] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevIdRef = useRef<string | null>(null);

  if (selectedId !== prevIdRef.current) {
    log.debug("[LibraryContent] hydration: selectedId changed", {
      prevId: prevIdRef.current,
      newId: selectedId,
      hasInitialContent: initialContent !== null,
      contentSize: initialContent ? JSON.stringify(initialContent).length : 0,
      plainTextLength: initialPlainText?.length ?? 0,
    });
    prevIdRef.current = selectedId;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setEditTitle(initialTitle);
    setEditContent(initialContent);
    setEditPlainText(initialPlainText);
    setIsDirty(false);
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  const scheduleSave = useCallback(
    (id: string, title: string, content: JSONContent | null, plainTextContent: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveMutation.mutate({ id, title, content, plainTextContent });
      }, debounceMs);
    },
    [saveMutation, debounceMs],
  );

  const handleContentChange = useCallback(
    (json: JSONContent, plainText: string) => {
      setEditContent(json);
      setEditPlainText(plainText);
      setIsDirty(true);
      if (selectedId) {
        setEditTitle((currentTitle) => {
          scheduleSave(selectedId, currentTitle, json, plainText);
          return currentTitle;
        });
      }
    },
    [selectedId, scheduleSave],
  );

  const handleTitleChange = useCallback(
    (value: string) => {
      setEditTitle(value);
      setIsDirty(true);
      if (selectedId) {
        setEditContent((currentContent) => {
          setEditPlainText((currentPlainText) => {
            scheduleSave(selectedId, value, currentContent, currentPlainText);
            return currentPlainText;
          });
          return currentContent;
        });
      }
    },
    [selectedId, scheduleSave],
  );

  return {
    editTitle,
    setEditTitle,
    editContent,
    setEditContent,
    editPlainText,
    setEditPlainText,
    isDirty,
    setIsDirty,
    handleContentChange,
    handleTitleChange,
    saveTimerRef,
  };
}
