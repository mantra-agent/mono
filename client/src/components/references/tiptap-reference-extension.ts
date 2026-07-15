import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Extension } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { queryClient } from "@/lib/queryClient";
import { parseReferenceText } from "@shared/reference-parser";
import type { ReferenceRef } from "@shared/references";
import { ReferenceRenderer } from "./reference-renderer";

function createReferenceWidget(ref: ReferenceRef): HTMLElement {
  const container = document.createElement("span");
  container.dataset.referenceWidget = "true";
  container.dataset.referenceType = ref.type;
  container.dataset.referenceId = ref.id;

  const root = createRoot(container);
  root.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ReferenceRenderer, { refValue: ref, surface: "chat-inline" }),
    ),
  );

  (container as HTMLElement & { __referenceRoot?: Root }).__referenceRoot = root;
  return container;
}

function referenceDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const parts = parseReferenceText(node.text);
    let offset = 0;

    for (const part of parts) {
      if (part.kind === "text") {
        offset += part.text.length;
        continue;
      }

      const rawLength = part.ref.raw.length;
      const from = pos + offset;
      const to = from + rawLength;

      decorations.push(
        Decoration.inline(from, to, {
          class: "reference-source-hidden",
          "data-reference-source": part.ref.canonical,
        }),
        Decoration.widget(from, () => createReferenceWidget(part.ref), {
          side: -1,
          key: `${from}:${part.ref.canonical}`,
          ignoreSelection: false,
          destroy(node) {
            (node as HTMLElement & { __referenceRoot?: Root }).__referenceRoot?.unmount();
          },
        }),
      );
      offset += rawLength;
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const ReferenceWidgetExtension = Extension.create({
  name: "referenceWidgets",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("referenceWidgets"),
        props: {
          decorations(state) {
            return referenceDecorations(state.doc);
          },
        },
      }),
    ];
  },
});
