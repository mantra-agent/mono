import { Loader2 } from "lucide-react";
import { ReferenceText } from "@/components/references/reference-text";
import { cn } from "@/lib/utils";

const SIMPLE_MARKDOWN_COMPONENTS = {};

export function SimpleTextFrame({
  content,
  loading = false,
  error,
  empty = "No content available.",
  className,
}: {
  content?: string | null;
  loading?: boolean;
  error?: string | null;
  empty?: string;
  className?: string;
}) {
  const text = content?.trim() ?? "";

  return (
    <div
      className={cn(
        "max-h-80 max-w-none overflow-auto rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-xs leading-relaxed text-white prose prose-sm dark:prose-invert [&_*]:text-white [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:font-mono [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:text-cta [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_img]:h-auto [&_img]:max-w-full",
        className,
      )}
    >
      {loading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : error ? (
        <p className="italic text-muted-foreground">{error}</p>
      ) : text ? (
        <ReferenceText content={text} markdownComponents={SIMPLE_MARKDOWN_COMPONENTS} />
      ) : (
        <p className="italic text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
