interface JSONContent {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export function tiptapToMarkdown(node: JSONContent): string {
  if (!node) return "";
  const type = node.type;
  const children = (node.content ?? []).map(tiptapToMarkdown).join("");

  if (type === "doc") return children.trim();
  if (type === "paragraph") return children ? `${children}\n\n` : "\n";
  if (type === "hardBreak") return "  \n";
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
  if (type === "bulletList") return children;
  if (type === "orderedList") {
    let idx = 0;
    return (node.content ?? []).map(item => {
      idx++;
      return `${idx}. ${tiptapToMarkdown(item).replace(/^\s*/, "").replace(/\n+$/, "")}\n`;
    }).join("") + "\n";
  }
  if (type === "listItem") return children;
  if (type === "blockquote") return children.split("\n").map(l => `> ${l}`).join("\n") + "\n";
  if (type === "codeBlock") {
    const lang = (node.attrs as Record<string, string>)?.language ?? "";
    return `\`\`\`${lang}\n${node.content?.map(n => n.text ?? "").join("") ?? ""}\n\`\`\`\n\n`;
  }
  if (type === "horizontalRule") return `---\n\n`;
  if (type === "table") {
    const rows = (node.content ?? []);
    if (rows.length === 0) return "";
    const tableRows = rows.map(row =>
      "| " + (row.content ?? []).map(cell =>
        (cell.content ?? []).map(tiptapToMarkdown).join("").replace(/\n+/g, " ").trim()
      ).join(" | ") + " |"
    );
    const headerRow = tableRows[0];
    const colCount = (rows[0].content ?? []).length;
    const separator = "| " + Array(colCount).fill("---").join(" | ") + " |";
    return [headerRow, separator, ...tableRows.slice(1)].join("\n") + "\n\n";
  }
  if (type === "image") {
    const attrs = (node.attrs as Record<string, string>) ?? {};
    return `![${attrs.alt ?? ""}](${attrs.src ?? ""})\n\n`;
  }
  return children;
}

function parseInlineMarks(text: string): JSONContent[] {
  const nodes: JSONContent[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, m.index) });
    }
    if (m[2]) {
      nodes.push({ type: "text", marks: [{ type: "bold" }], text: m[2] });
    } else if (m[3]) {
      nodes.push({ type: "text", marks: [{ type: "italic" }], text: m[3] });
    } else if (m[4]) {
      nodes.push({ type: "text", marks: [{ type: "strike" }], text: m[4] });
    } else if (m[5]) {
      nodes.push({ type: "text", marks: [{ type: "code" }], text: m[5] });
    } else if (m[6] && m[7]) {
      nodes.push({ type: "text", marks: [{ type: "link", attrs: { href: m[7] } }], text: m[6] });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }
  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

export function syncContentFields(input: { markdown?: string; tiptapJson?: JSONContent }): { content: JSONContent; plainTextContent: string } {
  if (isValidTiptapDoc(input.tiptapJson)) {
    const content = input.tiptapJson;
    const plainTextContent = tiptapToMarkdown(content);
    return { content, plainTextContent };
  }
  const md = input.markdown ?? "";
  const content = markdownToTiptap(md);
  const plainTextContent = tiptapToMarkdown(content);
  return { content, plainTextContent };
}

export function isValidTiptapDoc(value: unknown): value is JSONContent {
  if (!value || typeof value !== "object") return false;
  const doc = value as JSONContent;
  return doc.type === "doc" && Array.isArray(doc.content) && doc.content.length > 0;
}

export function markdownToTiptap(md: string): JSONContent {
  if (!md.trim()) return { type: "doc", content: [{ type: "paragraph" }] };
  const lines = md.split("\n");
  const content: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      content.push({ type: "heading", attrs: { level: headingMatch[1].length }, content: parseInlineMarks(headingMatch[2]) });
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      content.push({ type: "codeBlock", attrs: { language: lang }, content: [{ type: "text", text: codeLines.join("\n") }] });
      continue;
    }

    if (line.startsWith("---") || line.startsWith("***") || line.startsWith("___")) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      content.push({ type: "image", attrs: { src: imageMatch[2], alt: imageMatch[1] || null, title: null } });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      content.push({ type: "blockquote", content: [{ type: "paragraph", content: parseInlineMarks(quoteLines.join("\n")) }] });
      continue;
    }

    if (line.startsWith("| ")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("| ")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const rows = tableLines.filter((_, idx) => idx !== 1);
        const cellAttrs = { colspan: 1, rowspan: 1, colwidth: null };
        const parsedRows: JSONContent[] = rows.map((row, rowIdx) => ({
          type: "tableRow",
          content: row.split("|").slice(1, -1).map(cell => ({
            type: rowIdx === 0 ? "tableHeader" : "tableCell",
            attrs: cellAttrs,
            content: [{ type: "paragraph", content: parseInlineMarks(cell.trim()) }],
          })),
        }));
        const headerColCount = (parsedRows[0]?.content ?? []).length || 1;
        const tableContent: JSONContent[] = parsedRows.map((row, rowIdx) => {
          const cells = row.content ?? [];
          const cellType = rowIdx === 0 ? "tableHeader" : "tableCell";
          if (cells.length < headerColCount) {
            const padded = [...cells];
            while (padded.length < headerColCount) {
              padded.push({ type: cellType, attrs: cellAttrs, content: [{ type: "paragraph" }] });
            }
            return { ...row, content: padded };
          } else if (cells.length > headerColCount) {
            return { ...row, content: cells.slice(0, headerColCount) };
          }
          return row;
        });
        content.push({ type: "table", content: tableContent });
        continue;
      }
    }

    const bulletMatch = line.match(/^[-*+]\s+(.+)/);
    if (bulletMatch) {
      const items: JSONContent[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*+]\s+/, "");
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInlineMarks(itemText) }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.+)/);
    if (orderedMatch) {
      const items: JSONContent[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\d+\.\s+/, "");
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInlineMarks(itemText) }] });
        i++;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    content.push({ type: "paragraph", content: parseInlineMarks(line) });
    i++;
  }

  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}
