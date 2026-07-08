import { parseReferenceText } from "@shared/reference-parser";
import { ReferenceRenderer, type ReferenceSurface } from "./reference-renderer";

/**
 * Renders text containing `@type:id` handles as inline reference chips
 * without pulling in ReactMarkdown. Use for non-markdown contexts like
 * goal titles, badges, and picker labels.
 */
export function InlineReferenceText({
  text,
  className,
  surface = "chat-inline",
}: {
  text: string;
  className?: string;
  surface?: ReferenceSurface;
}) {
  const parts = parseReferenceText(text);

  if (!parts.some((p) => p.kind === "reference")) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <ReferenceRenderer
            key={i}
            refValue={part.ref}
            surface={surface}
          />
        ),
      )}
    </span>
  );
}
