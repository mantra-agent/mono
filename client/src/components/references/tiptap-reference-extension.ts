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

type ReferenceWidgetElement = HTMLElement & { __referenceRoot?: Root };

function releaseReferenceRoot(node: Node): void {
  const widget = node as ReferenceWidgetElement;
  const root = widget.__referenceRoot;
  if (!root) return;

  delete widget.__referenceRoot;
  queueMicrotask(() => root.unmount());
}

function createReferenceWidget(ref: ReferenceRef): HTMLElement {
  const container = document.createElement("span") as ReferenceWidgetElement;
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

  container.__referenceRoot = root;
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
          destroy: releaseReferenceRoot,
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
