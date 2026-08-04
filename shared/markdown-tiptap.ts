interface JSONContent {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

interface TiptapDocument extends JSONContent {
  type: "doc";
  content: JSONContent[];
}

export function tiptapToMarkdown(node: JSONContent): string {
  if (!node) return "";
  const type = node.type;
  const children = (node.content ?? []).map(tiptapToMarkdown).join("");

  if (type === "doc") return children.trim();
  if (type === "paragraph") return children ? `${children}\n\n` : "\n";
  if (type === "hardBreak") return " \n";
  if (type === "text") {
    let text = node.text ?? "";
    if (node.marks) {
      for (const mark of node.marks) {
        if (mark.type === "bold") text = `**${text}**`;
        else if (mark.type === "italic") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
        else if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "link") text = `[${text}](${(mark.attrs as Record<string, string>)?.href ?? ""})`;
      }
    }
    return text;
  }
  if (type === "heading") {
    const level = (node.attrs as Record<string, number>)?.level ?? 1;
    return `${"#".repeat(level)} ${children.trim()}\n\n`;
  }
  if (type === "bulletList") {
    return (node.content ?? [])
      .map((item) => `- ${tiptapToMarkdown(item).trim()}`)
      .join("\n") + "\n\n";
  }
  if (type === "orderedList") {
    return (node.content ?? [])
      .map((item, i) => `${i + 1}. ${tiptapToMarkdown(item).trim()}`)
      .join("\n") + "\n\n";
  }
  if (type === "listItem") return children.trim();
  if (type === "codeBlock") {
    const lang = (node.attrs as Record<string, string>)?.language ?? "";
    const code = (node.content ?? []).map((n) => n.text ?? "").join("");
    return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  }
  if (type === "blockquote") {
    return children
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n") + "\n\n";
  }
  if (type === "horizontalRule") return "---\n\n";
  if (type === "image") {
    const attrs = node.attrs as Record<string, string>;
    return `![${attrs?.alt ?? ""}](${attrs?.src ?? ""})\n\n`;
  }
  if (type === "table") {
    const rows = node.content ?? [];
    if (rows.length === 0) return "";
    const mdRows = rows.map((row) => {
      const cells = (row.content ?? []).map((cell) => tiptapToMarkdown(cell).trim().replace(/\n+/g, " "));
      return `| ${cells.join(" | ")} |`;
    });
    if (mdRows.length > 0) {
      const colCount = (rows[0].content ?? []).length || 1;
      const sep = `| ${Array(colCount).fill("---").join(" | ")} |`;
      mdRows.splice(1, 0, sep);
    }
    return mdRows.join("\n") + "\n\n";
  }
  if (type === "tableRow") return children;
  if (type === "tableCell" || type === "tableHeader") return children.trim();
  return children;
}

/** Inline marks only — never emits empty text nodes. */
function parseInlineMarks(text: string): JSONContent[] {
  if (!text) return [];
  const nodes: JSONContent[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      if (plain) nodes.push({ type: "text", text: plain });
    }
    if (match[2] !== undefined) {
      if (match[2]) nodes.push({ type: "text", text: match[2], marks: [{ type: "bold" }] });
    } else if (match[3] !== undefined) {
      if (match[3]) nodes.push({ type: "text", text: match[3], marks: [{ type: "italic" }] });
    } else if (match[4] !== undefined) {
      if (match[4]) nodes.push({ type: "text", text: match[4], marks: [{ type: "strike" }] });
    } else if (match[5] !== undefined) {
      if (match[5]) nodes.push({ type: "text", text: match[5], marks: [{ type: "code" }] });
    } else if (match[6] !== undefined) {
      if (match[6]) {
        nodes.push({
          type: "text",
          text: match[6],
          marks: [{ type: "link", attrs: { href: match[7] } }],
        });
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    if (plain) nodes.push({ type: "text", text: plain });
  }
  return nodes;
}

/** Table cells require block content (paragraph), never bare inline text. */
function cellFromText(text: string, header: boolean): JSONContent {
  const inlines = parseInlineMarks(text.trim());
  return {
    type: header ? "tableHeader" : "tableCell",
    content: [
      inlines.length > 0
        ? { type: "paragraph", content: inlines }
        : { type: "paragraph" },
    ],
  };
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "codeBlock",
  "blockquote",
  "horizontalRule",
  "image",
  "table",
  "hardBreak",
]);

function isInlineNode(node: JSONContent): boolean {
  return node.type === "text" || node.type === "hardBreak";
}

function isBlockNode(node: JSONContent): boolean {
  return !!node.type && BLOCK_TYPES.has(node.type);
}

/**
 * Repair a single node into schema-safe TipTap JSON.
 * - drops empty text nodes (ProseMirror rejects them)
 * - wraps bare inlines inside table cells into paragraphs
 * - ensures table cells/headers always have at least one paragraph
 */
function sanitizeNode(node: JSONContent): JSONContent | null {
  if (!node || typeof node !== "object") return null;

  if (node.type === "text") {
    if (typeof node.text !== "string" || node.text.length === 0) return null;
    return node;
  }

  const rawChildren = Array.isArray(node.content) ? node.content : undefined;
  const sanitizedChildren = rawChildren
    ? rawChildren
        .map(sanitizeNode)
        .filter((child): child is JSONContent => child !== null)
    : undefined;

  if (node.type === "tableCell" || node.type === "tableHeader") {
    const children = sanitizedChildren ?? [];
    const hasBlocks = children.some(isBlockNode);
    const inlines = children.filter(isInlineNode);
    const blocks = children.filter(isBlockNode);

    let nextContent: JSONContent[];
    if (hasBlocks && inlines.length === 0) {
      nextContent = blocks;
    } else if (inlines.length > 0 && !hasBlocks) {
      nextContent = [{ type: "paragraph", content: inlines }];
    } else if (inlines.length > 0 && hasBlocks) {
      // Mixed invalid content: wrap leftover inlines into a leading paragraph.
      nextContent = [{ type: "paragraph", content: inlines }, ...blocks];
    } else {
      nextContent = [{ type: "paragraph" }];
    }

    return { ...node, content: nextContent };
  }

  if (node.type === "tableRow") {
    const cells = (sanitizedChildren ?? []).filter(
      (child) => child.type === "tableCell" || child.type === "tableHeader",
    );
    if (cells.length === 0) return null;
    return { ...node, content: cells };
  }

  if (node.type === "table") {
    const rows = (sanitizedChildren ?? []).filter((child) => child.type === "tableRow");
    if (rows.length === 0) return null;
    return { ...node, content: rows };
  }

  if (node.type === "paragraph" || node.type === "heading") {
    const children = sanitizedChildren ?? [];
    // Paragraphs/headings may be empty (valid). Drop only null children already filtered.
    return children.length > 0 ? { ...node, content: children } : { ...node, content: undefined };
  }

  if (sanitizedChildren) {
    return { ...node, content: sanitizedChildren };
  }
  return node;
}

export function isValidTiptapDoc(value: unknown): value is TiptapDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as JSONContent;
  return doc.type === "doc" && Array.isArray(doc.content);
}

export function normalizeTiptapDoc(value: unknown): TiptapDocument | null {
  if (!isValidTiptapDoc(value)) return null;
  const sanitized = sanitizeNode(value);
  if (!sanitized || sanitized.type !== "doc") return null;
  const content = Array.isArray(sanitized.content) ? sanitized.content : [];
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

export function markdownToTiptap(md: string): JSONContent {
  if (!md.trim()) return { type: "doc", content: [{ type: "paragraph" }] };

  const lines = md.split("\n");
  const content: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      content.push({
        type: "codeBlock",
        attrs: { language: lang || null },
        content: codeLines.length > 0 ? [{ type: "text", text: codeLines.join("\n") }] : [],
      });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const inlines = parseInlineMarks(headingMatch[2]);
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1].length },
        ...(inlines.length > 0 ? { content: inlines } : {}),
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      content.push({
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: parseInlineMarks(quoteLines.join("\n")),
          },
        ],
      });
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*+]\s+/.test(line)) {
      const items: JSONContent[] = [];
      while (i < lines.length && /^[\s]*[-*+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*[-*+]\s+/, "");
        const inlines = parseInlineMarks(itemText);
        items.push({
          type: "listItem",
          content: [
            inlines.length > 0
              ? { type: "paragraph", content: inlines }
              : { type: "paragraph" },
          ],
        });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s+/.test(line)) {
      const items: JSONContent[] = [];
      while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\s]*\d+\.\s+/, "");
        const inlines = parseInlineMarks(itemText);
        items.push({
          type: "listItem",
          content: [
            inlines.length > 0
              ? { type: "paragraph", content: inlines }
              : { type: "paragraph" },
          ],
        });
        i++;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    // Table — cells must contain paragraphs, not bare text nodes
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableRows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].trim().startsWith("|") &&
        lines[i].trim().endsWith("|")
      ) {
        const row = lines[i].trim();
        // Skip separator rows like |---|---|
        if (/^\|[\s:|-]+\|$/.test(row)) {
          i++;
          continue;
        }
        const cells = row
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        tableRows.push(cells);
        i++;
      }
      if (tableRows.length > 0) {
        content.push({
          type: "table",
          content: tableRows.map((row, rowIdx) => ({
            type: "tableRow",
            content: row.map((cell) => cellFromText(cell, rowIdx === 0)),
          })),
        });
      }
      continue;
    }

    // Image
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      content.push({
        type: "image",
        attrs: { src: imgMatch[2], alt: imgMatch[1] },
      });
      i++;
      continue;
    }

    // Default: paragraph
    const inlines = parseInlineMarks(line);
    content.push(
      inlines.length > 0
        ? { type: "paragraph", content: inlines }
        : { type: "paragraph" },
    );
    i++;
  }

  if (content.length === 0) content.push({ type: "paragraph" });
  // Final sanitize pass guarantees schema-safe output even if a branch regresses.
  return normalizeTiptapDoc({ type: "doc", content }) ?? {
    type: "doc",
    content: [{ type: "paragraph" }],
  };
}

export function syncContentFields(input: {
  markdown?: string;
  tiptapJson?: JSONContent;
}): { content: JSONContent; plainTextContent: string } {
  const normalizedContent = normalizeTiptapDoc(input.tiptapJson);
  if (normalizedContent) {
    return {
      content: normalizedContent,
      plainTextContent: tiptapToMarkdown(normalizedContent),
    };
  }
  const md = input.markdown ?? "";
  const content = markdownToTiptap(md);
  return {
    content,
    plainTextContent: md || tiptapToMarkdown(content),
  };
}
