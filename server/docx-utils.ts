import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const WORD_NS = "w";
const ALWAYS_ARRAY_TAGS = [
  `${WORD_NS}:p`, `${WORD_NS}:r`, `${WORD_NS}:t`, `${WORD_NS}:ins`,
  `${WORD_NS}:del`, `${WORD_NS}:rPr`, `${WORD_NS}:pPr`,
  `${WORD_NS}:commentRangeStart`, `${WORD_NS}:commentRangeEnd`,
  `${WORD_NS}:commentReference`, `${WORD_NS}:comment`,
  `${WORD_NS}:delText`, `${WORD_NS}:tbl`, `${WORD_NS}:tr`, `${WORD_NS}:tc`,
];

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    trimValues: false,
    cdataPropName: "__cdata",
    commentPropName: "__comment",
    isArray: (tagName) => ALWAYS_ARRAY_TAGS.includes(tagName),
  });
}

function makeBuilder(): XMLBuilder {
  return new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    format: false,
    suppressEmptyNode: false,
    cdataPropName: "__cdata",
    commentPropName: "__comment",
  });
}

export interface DocxComment {
  id: string;
  author: string;
  date: string;
  text: string;
}

export interface TrackedChange {
  type: "insertion" | "deletion";
  author: string;
  date: string;
  text: string;
}

export interface RichParagraph {
  type: "heading" | "paragraph" | "list-item" | "table-cell";
  headingLevel?: number;
  runs: RichRun[];
  comments: DocxComment[];
  trackedChanges: TrackedChange[];
}

export interface RichRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  highlight?: string;
  fontSize?: number;
  fontFamily?: string;
}

export interface RichDocxContent {
  paragraphs: RichParagraph[];
  comments: DocxComment[];
  trackedChanges: TrackedChange[];
  metadata: {
    title?: string;
    author?: string;
    created?: string;
    modified?: string;
  };
}

function extractText(nodes: any[]): string {
  if (!nodes || !Array.isArray(nodes)) return "";
  let result = "";
  for (const node of nodes) {
    if (node[`${WORD_NS}:t`]) {
      const tNodes = node[`${WORD_NS}:t`];
      for (const t of Array.isArray(tNodes) ? tNodes : [tNodes]) {
        if (typeof t === "string") result += t;
        else if (t?.["#text"] !== undefined) result += t["#text"];
        else if (Array.isArray(t)) {
          for (const sub of t) {
            if (sub?.["#text"] !== undefined) result += sub["#text"];
          }
        }
      }
    }
    if (node[`${WORD_NS}:delText`]) {
      const dtNodes = node[`${WORD_NS}:delText`];
      for (const dt of Array.isArray(dtNodes) ? dtNodes : [dtNodes]) {
        if (typeof dt === "string") result += dt;
        else if (dt?.["#text"] !== undefined) result += dt["#text"];
        else if (Array.isArray(dt)) {
          for (const sub of dt) {
            if (sub?.["#text"] !== undefined) result += sub["#text"];
          }
        }
      }
    }
  }
  return result;
}

function parseRunProps(rPr: any[]): Partial<RichRun> {
  const props: Partial<RichRun> = {};
  if (!rPr || !Array.isArray(rPr)) return props;
  for (const item of rPr) {
    if (item[`${WORD_NS}:b`] !== undefined) props.bold = true;
    if (item[`${WORD_NS}:bCs`] !== undefined) props.bold = true;
    if (item[`${WORD_NS}:i`] !== undefined) props.italic = true;
    if (item[`${WORD_NS}:iCs`] !== undefined) props.italic = true;
    if (item[`${WORD_NS}:u`] !== undefined) props.underline = true;
    if (item[`${WORD_NS}:strike`] !== undefined) props.strikethrough = true;
    if (item[`${WORD_NS}:highlight`]) {
      const hlArr = Array.isArray(item[`${WORD_NS}:highlight`]) ? item[`${WORD_NS}:highlight`] : [item[`${WORD_NS}:highlight`]];
      for (const hl of hlArr) {
        if (hl?.[":@"]?.[`@_${WORD_NS}:val`]) props.highlight = hl[":@"][`@_${WORD_NS}:val`];
      }
    }
    if (item[`${WORD_NS}:sz`]) {
      const szArr = Array.isArray(item[`${WORD_NS}:sz`]) ? item[`${WORD_NS}:sz`] : [item[`${WORD_NS}:sz`]];
      for (const sz of szArr) {
        const val = sz?.[":@"]?.[`@_${WORD_NS}:val`];
        if (val) props.fontSize = parseInt(val, 10) / 2;
      }
    }
    if (item[`${WORD_NS}:rFonts`]) {
      const fArr = Array.isArray(item[`${WORD_NS}:rFonts`]) ? item[`${WORD_NS}:rFonts`] : [item[`${WORD_NS}:rFonts`]];
      for (const f of fArr) {
        const ascii = f?.[":@"]?.[`@_${WORD_NS}:ascii`];
        if (ascii) props.fontFamily = ascii;
      }
    }
  }
  return props;
}

function getHeadingLevel(pPr: any[]): number | undefined {
  if (!pPr || !Array.isArray(pPr)) return undefined;
  for (const item of pPr) {
    if (item[`${WORD_NS}:pStyle`]) {
      const styles = Array.isArray(item[`${WORD_NS}:pStyle`]) ? item[`${WORD_NS}:pStyle`] : [item[`${WORD_NS}:pStyle`]];
      for (const s of styles) {
        const val = s?.[":@"]?.[`@_${WORD_NS}:val`] || "";
        const match = val.match(/Heading(\d)/i);
        if (match) return parseInt(match[1], 10);
      }
    }
  }
  return undefined;
}

function isListItem(pPr: any[]): boolean {
  if (!pPr || !Array.isArray(pPr)) return false;
  for (const item of pPr) {
    if (item[`${WORD_NS}:numPr`]) return true;
  }
  return false;
}

export async function readDocxRich(source: string | Buffer): Promise<RichDocxContent> {
  const fileBuffer = Buffer.isBuffer(source) ? source : await readFile(source);
  const zip = await JSZip.loadAsync(fileBuffer);
  const maxUncompressedBytes = 100 * 1024 * 1024;
  const uncompressedBytes = Object.values(zip.files).reduce((total, entry) => {
    const size = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    return total + (typeof size === "number" ? size : 0);
  }, 0);
  if (uncompressedBytes > maxUncompressedBytes) {
    throw new Error("DOCX uncompressed content exceeds the 100 MB read limit");
  }
  const parser = makeParser();

  const commentsMap = new Map<string, DocxComment>();
  const commentsFile = zip.file("word/comments.xml");
  if (commentsFile) {
    try {
      const commentsXml = await commentsFile.async("string");
      const parsed = parser.parse(commentsXml);
      const commentsRoot = findTag(parsed, `${WORD_NS}:comments`);
      if (commentsRoot) {
        const commentNodes = findAllTags(commentsRoot, `${WORD_NS}:comment`);
        for (const c of commentNodes) {
          const attrs = c[":@"] || {};
          const id = attrs[`@_${WORD_NS}:id`] || "";
          const author = attrs[`@_${WORD_NS}:author`] || "Unknown";
          const date = attrs[`@_${WORD_NS}:date`] || "";
          const paragraphs = findAllTags(c[`${WORD_NS}:comment`] || [], `${WORD_NS}:p`);
          let text = "";
          for (const p of paragraphs) {
            const runs = findAllTags(p[`${WORD_NS}:p`] || [], `${WORD_NS}:r`);
            for (const r of runs) {
              text += extractText(r[`${WORD_NS}:r`] || []);
            }
            text += "\n";
          }
          commentsMap.set(id, { id, author, date, text: text.trim() });
        }
      }
    } catch { /* comments parse failure is non-fatal */ }
  }

  const metadata: RichDocxContent["metadata"] = {};
  const coreFile = zip.file("docProps/core.xml");
  if (coreFile) {
    try {
      const coreXml = await coreFile.async("string");
      const titleMatch = coreXml.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/);
      const authorMatch = coreXml.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/);
      const createdMatch = coreXml.match(/<dcterms:created[^>]*>([^<]*)<\/dcterms:created>/);
      const modifiedMatch = coreXml.match(/<dcterms:modified[^>]*>([^<]*)<\/dcterms:modified>/);
      if (titleMatch) metadata.title = titleMatch[1];
      if (authorMatch) metadata.author = authorMatch[1];
      if (createdMatch) metadata.created = createdMatch[1];
      if (modifiedMatch) metadata.modified = modifiedMatch[1];
    } catch { /* metadata parse failure is non-fatal */ }
  }

  const docXml = await zip.file("word/document.xml")!.async("string");
  const docParsed = parser.parse(docXml);
  const body = findTag(docParsed, `${WORD_NS}:body`);
  if (!body) throw new Error("Could not find document body");

  const allTrackedChanges: TrackedChange[] = [];
  const paragraphs: RichParagraph[] = [];

  const bodyContent = body[`${WORD_NS}:body`] || [];
  const pNodes = findAllTags(bodyContent, `${WORD_NS}:p`);

  for (const pNode of pNodes) {
    const pContent = pNode[`${WORD_NS}:p`] || [];
    const pPrNodes = findAllTags(pContent, `${WORD_NS}:pPr`);
    const pPr = pPrNodes.length > 0 ? (pPrNodes[0][`${WORD_NS}:pPr`] || []) : [];

    const headingLevel = getHeadingLevel(pPr);
    const isList = isListItem(pPr);

    const runs: RichRun[] = [];
    const paraComments: DocxComment[] = [];
    const paraChanges: TrackedChange[] = [];

    const activeCommentIds = new Set<string>();

    for (const item of pContent) {
      if (item[`${WORD_NS}:commentRangeStart`]) {
        const starts = Array.isArray(item[`${WORD_NS}:commentRangeStart`]) ? item[`${WORD_NS}:commentRangeStart`] : [item[`${WORD_NS}:commentRangeStart`]];
        for (const s of starts) {
          const id = s?.[":@"]?.[`@_${WORD_NS}:id`] || item[":@"]?.[`@_${WORD_NS}:id`];
          if (id) activeCommentIds.add(id);
        }
      }

      if (item[`${WORD_NS}:commentRangeEnd`]) {
        const ends = Array.isArray(item[`${WORD_NS}:commentRangeEnd`]) ? item[`${WORD_NS}:commentRangeEnd`] : [item[`${WORD_NS}:commentRangeEnd`]];
        for (const e of ends) {
          const id = e?.[":@"]?.[`@_${WORD_NS}:id`] || item[":@"]?.[`@_${WORD_NS}:id`];
          if (id) {
            const comment = commentsMap.get(id);
            if (comment) paraComments.push(comment);
            activeCommentIds.delete(id);
          }
        }
      }

      if (item[`${WORD_NS}:r`]) {
        const runChildren = item[`${WORD_NS}:r`];
        const rItems = Array.isArray(runChildren) ? runChildren : [runChildren];
        const rPrNodes = findAllTags(rItems, `${WORD_NS}:rPr`);
        const rPr = rPrNodes.length > 0 ? (rPrNodes[0][`${WORD_NS}:rPr`] || []) : [];
        const props = parseRunProps(rPr);
        const text = extractText(rItems);
        if (text) runs.push({ text, ...props });
      }

      if (item[`${WORD_NS}:ins`]) {
        const insNodes = Array.isArray(item[`${WORD_NS}:ins`]) ? item[`${WORD_NS}:ins`] : [item[`${WORD_NS}:ins`]];
        for (const insNode of insNodes) {
          const attrs = insNode[":@"] || item[":@"] || {};
          const author = attrs[`@_${WORD_NS}:author`] || "Unknown";
          const date = attrs[`@_${WORD_NS}:date`] || "";
          const insContent = Array.isArray(insNode) ? insNode : (insNode[`${WORD_NS}:ins`] || [insNode]);
          const insRuns = findAllTags(insContent, `${WORD_NS}:r`);
          for (const r of insRuns) {
            const text = extractText(r[`${WORD_NS}:r`] || []);
            if (text) {
              const change: TrackedChange = { type: "insertion", author, date, text };
              paraChanges.push(change);
              allTrackedChanges.push(change);
              runs.push({ text, underline: true });
            }
          }
        }
      }

      if (item[`${WORD_NS}:del`]) {
        const delNodes = Array.isArray(item[`${WORD_NS}:del`]) ? item[`${WORD_NS}:del`] : [item[`${WORD_NS}:del`]];
        for (const delNode of delNodes) {
          const attrs = delNode[":@"] || item[":@"] || {};
          const author = attrs[`@_${WORD_NS}:author`] || "Unknown";
          const date = attrs[`@_${WORD_NS}:date`] || "";
          const delContent = Array.isArray(delNode) ? delNode : (delNode[`${WORD_NS}:del`] || [delNode]);
          const delRuns = findAllTags(delContent, `${WORD_NS}:r`);
          for (const r of delRuns) {
            const rContent = r[`${WORD_NS}:r`] || [];
            const text = extractText(rContent);
            if (text) {
              const change: TrackedChange = { type: "deletion", author, date, text };
              paraChanges.push(change);
              allTrackedChanges.push(change);
              runs.push({ text, strikethrough: true });
            }
          }
        }
      }
    }

    for (const cid of activeCommentIds) {
      const comment = commentsMap.get(cid);
      if (comment) paraComments.push(comment);
    }

    paragraphs.push({
      type: headingLevel ? "heading" : isList ? "list-item" : "paragraph",
      headingLevel,
      runs,
      comments: paraComments,
      trackedChanges: paraChanges,
    });
  }

  return {
    paragraphs,
    comments: Array.from(commentsMap.values()),
    trackedChanges: allTrackedChanges,
    metadata,
  };
}

export function formatRichContent(content: RichDocxContent, mode: "structured" | "annotated" = "structured"): string {
  const parts: string[] = [];

  if (Object.values(content.metadata).some(Boolean)) {
    const metaParts: string[] = [];
    if (content.metadata.title) metaParts.push(`Title: ${content.metadata.title}`);
    if (content.metadata.author) metaParts.push(`Author: ${content.metadata.author}`);
    if (content.metadata.created) metaParts.push(`Created: ${content.metadata.created}`);
    if (content.metadata.modified) metaParts.push(`Modified: ${content.metadata.modified}`);
    parts.push(`[Document Metadata]\n${metaParts.join("\n")}`);
  }

  if (content.comments.length > 0 && mode === "structured") {
    parts.push(`[Comments: ${content.comments.length} total]`);
  }
  if (content.trackedChanges.length > 0 && mode === "structured") {
    const ins = content.trackedChanges.filter(c => c.type === "insertion").length;
    const del = content.trackedChanges.filter(c => c.type === "deletion").length;
    parts.push(`[Tracked Changes: ${ins} insertions, ${del} deletions]`);
  }

  parts.push("");

  for (const para of content.paragraphs) {
    let line = "";

    if (para.type === "heading" && para.headingLevel) {
      line += "#".repeat(para.headingLevel) + " ";
    } else if (para.type === "list-item") {
      line += "- ";
    }

    for (const run of para.runs) {
      if (mode === "annotated") {
        if (run.strikethrough) {
          line += `~~${run.text}~~`;
        } else if (run.bold && run.italic) {
          line += `***${run.text}***`;
        } else if (run.bold) {
          line += `**${run.text}**`;
        } else if (run.italic) {
          line += `*${run.text}*`;
        } else if (run.underline) {
          line += `__${run.text}__`;
        } else {
          line += run.text;
        }
      } else {
        line += run.text;
      }
    }

    parts.push(line);

    if (mode === "annotated" && para.trackedChanges.length > 0) {
      for (const change of para.trackedChanges) {
        const tag = change.type === "insertion" ? "INSERTED" : "DELETED";
        parts.push(`  [${tag} by ${change.author}${change.date ? ` on ${change.date.split("T")[0]}` : ""}]: "${change.text}"`);
      }
    }

    if (mode === "annotated" && para.comments.length > 0) {
      for (const comment of para.comments) {
        parts.push(`  [COMMENT by ${comment.author}${comment.date ? ` on ${comment.date.split("T")[0]}` : ""}]: "${comment.text}"`);
      }
    }
  }

  return parts.join("\n").trim();
}

export async function editDocxInPlace(
  sourceFilePath: string,
  outputFilePath: string,
  replacements: Array<{ find: string; replace: string }>,
): Promise<{ replacementsMade: number; bytesWritten: number }> {
  const fileBuffer = await readFile(sourceFilePath);
  const zip = await JSZip.loadAsync(fileBuffer);

  const docXml = await zip.file("word/document.xml")!.async("string");

  let modifiedXml = docXml;
  let totalReplacements = 0;

  for (const { find, replace } of replacements) {
    const escapedFind = find.replace(/[&<>"']/g, (ch) => {
      const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
      return map[ch] || ch;
    });
    const escapedReplace = replace.replace(/[&<>"']/g, (ch) => {
      const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
      return map[ch] || ch;
    });

    const regex = new RegExp(escapeRegex(find), "g");
    const textRegex = new RegExp(escapeRegex(escapedFind), "g");

    const plainMatches = (modifiedXml.match(textRegex) || []).length;
    if (plainMatches > 0) {
      modifiedXml = modifiedXml.replace(textRegex, escapedReplace);
      totalReplacements += plainMatches;
    } else {
      const rebuilt = rebuildSplitRuns(modifiedXml, find, replace);
      if (rebuilt.changed) {
        modifiedXml = rebuilt.xml;
        totalReplacements += rebuilt.count;
      }
    }
  }

  zip.file("word/document.xml", modifiedXml);

  const outputBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const dir = join(outputFilePath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(outputFilePath, outputBuffer);

  return { replacementsMade: totalReplacements, bytesWritten: outputBuffer.length };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildSplitRuns(xml: string, find: string, replace: string): { xml: string; changed: boolean; count: number } {
  const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let changed = false;
  let count = 0;

  const newXml = xml.replace(paragraphRegex, (paraXml) => {
    const textContentRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let fullText = "";
    const segments: Array<{ start: number; end: number; text: string; match: RegExpMatchArray }> = [];

    let m;
    while ((m = textContentRegex.exec(paraXml)) !== null) {
      segments.push({
        start: fullText.length,
        end: fullText.length + m[1].length,
        text: m[1],
        match: m,
      });
      fullText += m[1];
    }

    const findIdx = fullText.indexOf(find);
    if (findIdx === -1) return paraXml;

    const escapedReplace = replace.replace(/[&<>"']/g, (ch) => {
      const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
      return map[ch] || ch;
    });

    let result = paraXml;
    let replacedInThisPara = false;

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (seg.start <= findIdx && findIdx < seg.end) {
        const localStart = findIdx - seg.start;
        const remaining = find.length - (seg.text.length - localStart);

        if (remaining <= 0) {
          const newText = seg.text.substring(0, localStart) + replace + seg.text.substring(localStart + find.length);
          const escapedNewText = newText.replace(/[&<>"']/g, (ch) => {
            const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
            return map[ch] || ch;
          });
          result = result.replace(seg.match[0], seg.match[0].replace(seg.match[1], escapedNewText));
          replacedInThisPara = true;
        } else {
          const firstPart = seg.text.substring(0, localStart) + replace;
          const escapedFirst = firstPart.replace(/[&<>"']/g, (ch) => {
            const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
            return map[ch] || ch;
          });
          result = result.replace(seg.match[0], seg.match[0].replace(seg.match[1], escapedFirst));

          let consumed = seg.text.length - localStart;
          for (let sj = si + 1; sj < segments.length && consumed < find.length; sj++) {
            const nextSeg = segments[sj];
            const toConsume = Math.min(nextSeg.text.length, find.length - consumed);
            if (toConsume >= nextSeg.text.length) {
              result = result.replace(nextSeg.match[0], nextSeg.match[0].replace(nextSeg.match[1], ""));
            } else {
              const leftover = nextSeg.text.substring(toConsume);
              const escapedLeftover = leftover.replace(/[&<>"']/g, (ch) => {
                const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
                return map[ch] || ch;
              });
              result = result.replace(nextSeg.match[0], nextSeg.match[0].replace(nextSeg.match[1], escapedLeftover));
            }
            consumed += nextSeg.text.length;
          }
          replacedInThisPara = true;
        }
        break;
      }
    }

    if (replacedInThisPara) {
      changed = true;
      count++;
    }
    return result;
  });

  return { xml: newXml, changed, count };
}

function findTag(nodes: any[], tag: string): any | null {
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (node[tag] !== undefined) return node;
    for (const key of Object.keys(node)) {
      if (key === ":@" || key.startsWith("@_")) continue;
      const child = node[key];
      if (Array.isArray(child)) {
        const found = findTag(child, tag);
        if (found) return found;
      }
    }
  }
  return null;
}

function findAllTags(nodes: any[], tag: string): any[] {
  const results: any[] = [];
  if (!Array.isArray(nodes)) return results;
  for (const node of nodes) {
    if (node[tag] !== undefined) results.push(node);
  }
  return results;
}

export async function cloneDocxWithContent(
  sourceFilePath: string,
  outputFilePath: string,
  newContent: string,
): Promise<{ bytesWritten: number; paragraphsWritten: number }> {
  const fileBuffer = await readFile(sourceFilePath);
  const zip = await JSZip.loadAsync(fileBuffer);
  const parser = makeParser();
  const builder = makeBuilder();

  const docXml = await zip.file("word/document.xml")!.async("string");
  const docParsed = parser.parse(docXml);

  const bodyNode = findTag(docParsed, `${WORD_NS}:body`);
  if (!bodyNode) throw new Error("Could not find document body in source");

  const bodyContent = bodyNode[`${WORD_NS}:body`] || [];
  const sectPrNode = bodyContent.find((n: any) => n[`${WORD_NS}:sectPr`] !== undefined);

  const existingStyles = new Map<string, any>();
  const existingPNodes = findAllTags(bodyContent, `${WORD_NS}:p`);
  for (const pNode of existingPNodes) {
    const pContent = pNode[`${WORD_NS}:p`] || [];
    const pPrNodes = findAllTags(pContent, `${WORD_NS}:pPr`);
    if (pPrNodes.length > 0) {
      const pPr = pPrNodes[0][`${WORD_NS}:pPr`] || [];
      const level = getHeadingLevel(pPr);
      if (level !== undefined) {
        existingStyles.set(`heading${level}`, pPrNodes[0]);
      } else if (!existingStyles.has("body")) {
        const rPrNodes = findAllTags(pContent, `${WORD_NS}:r`);
        if (rPrNodes.length > 0) {
          const rContent = rPrNodes[0][`${WORD_NS}:r`] || [];
          const runPrNodes = findAllTags(Array.isArray(rContent) ? rContent : [rContent], `${WORD_NS}:rPr`);
          if (runPrNodes.length > 0) {
            existingStyles.set("body", { pPr: pPrNodes[0], rPr: runPrNodes[0] });
          }
        }
      }
    }
  }

  const lines = newContent.split("\n");
  const newParagraphs: any[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      newParagraphs.push({
        [`${WORD_NS}:p`]: [
          { [`${WORD_NS}:pPr`]: [{ [`${WORD_NS}:pStyle`]: [], ":@": { [`@_${WORD_NS}:val`]: `Heading${level}` } }] },
          { [`${WORD_NS}:r`]: [{ [`${WORD_NS}:t`]: [{ "#text": text }], ":@": { "@_xml:space": "preserve" } }] },
        ],
      });
    } else {
      const runContent: any[] = [{ [`${WORD_NS}:t`]: [{ "#text": line }], ":@": { "@_xml:space": "preserve" } }];
      const bodyStyle = existingStyles.get("body");
      if (bodyStyle?.rPr) {
        runContent.unshift(bodyStyle.rPr);
      }
      const pContent: any[] = [{ [`${WORD_NS}:r`]: runContent }];
      if (bodyStyle?.pPr) {
        pContent.unshift(bodyStyle.pPr);
      }
      newParagraphs.push({ [`${WORD_NS}:p`]: pContent });
    }
  }

  if (sectPrNode) newParagraphs.push(sectPrNode);
  bodyNode[`${WORD_NS}:body`] = newParagraphs;

  const newDocXml = builder.build(docParsed);
  const xmlDecl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const finalXml = newDocXml.startsWith("<?xml") ? newDocXml : xmlDecl + newDocXml;

  zip.file("word/document.xml", finalXml);

  const outputBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const dir = join(outputFilePath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(outputFilePath, outputBuffer);

  return { bytesWritten: outputBuffer.length, paragraphsWritten: newParagraphs.length };
}
