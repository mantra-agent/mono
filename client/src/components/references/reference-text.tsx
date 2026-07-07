import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseReferenceText } from "@shared/reference-parser";
import { isParseableReferenceType } from "@shared/references";
import { createReferenceRef } from "@shared/references";
import { ReferenceRenderer } from "./reference-renderer";

const REF_PROTOCOL = "ref://";
const CODE_WRAPPED_CANONICAL_REF = /`(@([A-Za-z_][A-Za-z0-9_]*):([^`\s\]<>]+))`/g;

function unwrapCodeWrappedReferenceTokens(content: string): string {
  return content.replace(CODE_WRAPPED_CANONICAL_REF, (match, canonical: string, type: string, id: string) => {
    if (!id) return match;
    return isParseableReferenceType(type) ? canonical : match;
  });
}

/** Allow ref:// protocol through react-markdown's URL sanitizer */
function urlTransform(url: string): string {
  if (url.startsWith(REF_PROTOCOL)) return url;
  return defaultUrlTransform(url);
}

/**
 * Shared img component factory for reference resolution.
 * Must be called inside useMemo so the returned component has a stable
 * identity across renders — otherwise React unmounts/remounts every
 * ReferenceChip on each parent re-render, preventing the async
 * useReferenceLabel hook from completing its fetch.
 */
function createRefImg(fallbackImg?: (props: any) => any) {
  return function RefImg({ src, alt, ...props }: any) {
    if (src?.startsWith(REF_PROTOCOL)) {
      const rest = src.slice(REF_PROTOCOL.length);
      const slashIndex = rest.indexOf("/");
      if (slashIndex > 0) {
        const type = rest.slice(0, slashIndex);
        const id = decodeURIComponent(rest.slice(slashIndex + 1));
        const ref = createReferenceRef({ type, id });
        return <ReferenceRenderer refValue={ref} surface="chat-inline" />;
      }
    }
    if (fallbackImg) return fallbackImg({ src, alt, ...props });
    return <img src={src} alt={alt} {...props} />;
  };
}

/**
 * Renders markdown content with inline reference links.
 *
 * Instead of splitting the document at reference boundaries (which breaks
 * markdown block structure — e.g. a list item split in two becomes a block
 * list followed by an orphaned inline chip), we replace reference tokens with
 * markdown image placeholders `![ref](ref://type/encodedId)` and render the
 * whole document through a single ReactMarkdown pass. A custom `img` override
 * intercepts those placeholders and renders ReferenceRenderer inline.
 */
export function ReferenceText({
  content,
  markdownComponents,
}: {
  content: string;
  markdownComponents: Record<string, any>;
}) {
  const normalizedContent = unwrapCodeWrappedReferenceTokens(content);
  const parts = parseReferenceText(normalizedContent);
  const hasReferences = parts.some(part => part.kind === "reference");

  // Stable component overrides — the img function reference must not change
  // between renders so React keeps ReferenceChip instances mounted, allowing
  // the async useReferenceLabel hook to resolve names from the server.
  const refComponents = useMemo(() => ({
    ...markdownComponents,
    img: createRefImg(markdownComponents.img),
  }), [markdownComponents]);

  if (!hasReferences) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{normalizedContent}</ReactMarkdown>;
  }

  // Reconstruct content with image placeholders for references
  const processedContent = parts.map(part =>
    part.kind === "text"
      ? part.text
      : `![ref](${REF_PROTOCOL}${part.ref.type}/${encodeURIComponent(part.ref.id)})`
  ).join("");

  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={refComponents}>{processedContent}</ReactMarkdown>;
}
