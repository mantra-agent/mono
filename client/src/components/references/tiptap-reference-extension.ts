import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { parseReferenceText } from "@shared/reference-parser";
import type { ReferenceRef } from "@shared/references";
import { resolveReference } from "./reference-registry";

function referenceClass(ref: ReferenceRef): string {
  return `reference-${ref.type}-${ref.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function createReferenceWidget(ref: ReferenceRef): HTMLElement {
  const resolved = resolveReference(ref);
  const label = resolved.label || ref.id;
  const href = resolved.status === "resolved" ? resolved.href : undefined;
  const element = document.createElement(href ? "a" : "span");

  element.className = [
    "mx-1 inline-flex max-w-full translate-y-[-1px] align-baseline items-center gap-1 whitespace-nowrap break-normal text-xs font-medium underline-offset-4 transition-colors no-underline",
    resolved.status === "resolved" ? "text-cta hover:text-active" : "text-muted-foreground",
    referenceClass(ref),
  ].join(" ");
  element.dataset.referenceType = ref.type;
  element.dataset.referenceId = ref.id;
  element.dataset.testid = `reference-${ref.type}-${ref.id}`;
  element.title = resolved.description || ref.canonical;

  if (href) {
    element.setAttribute("href", href);
    if (href.startsWith("http://") || href.startsWith("https://")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }

  const type = document.createElement("span");
  type.className = "rounded-sm border border-current/25 px-0.5 text-[10px] uppercase leading-tight opacity-70";
  type.textContent = ref.type.replace(/_/g, " ");

  const labelElement = document.createElement("span");
  labelElement.className = "min-w-0 truncate border-b border-current leading-tight";
  labelElement.textContent = label;

  element.append(type, labelElement);
  return element;
}

function referenceDecorations(doc: Parameters<DecorationSet["map"]>[2]): DecorationSet {
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
          ignoreSelection: false,
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
          handleClick(_view, _pos, event) {
            const target = event.target as HTMLElement | null;
            const anchor = target?.closest("a[data-reference-type]") as HTMLAnchorElement | null;
            if (!anchor) return false;
            const href = anchor.getAttribute("href");
            if (!href || href.startsWith("http://") || href.startsWith("https://")) return false;
            event.preventDefault();
            window.history.pushState({}, "", href);
            window.dispatchEvent(new PopStateEvent("popstate"));
            return true;
          },
        },
      }),
    ];
  },
});
