/**
 * Convert common Markdown produced by the model into Slack mrkdwn.
 * Single outbound formatting boundary for Slack transport text.
 *
 * Slack mrkdwn basics (docs.slack.dev/messaging/formatting-message-text):
 *   *bold*  _italic_  ~strike~  `code`  ```pre```  > quote  <url|label>
 * Control characters &, <, > must be HTML-entity escaped when not intentional syntax.
 */

const FENCE_PH = (i: number) => `\u0000F${i}\u0000`;
const CODE_PH = (i: number) => `\u0000C${i}\u0000`;
const BOLD_PH = (i: number) => `\u0000B${i}\u0000`;
const ITALIC_PH = (i: number) => `\u0000I${i}\u0000`;
const STRIKE_PH = (i: number) => `\u0000S${i}\u0000`;
const LINK_PH = (i: number) => `\u0000L${i}\u0000`;

/** Convert model Markdown into Slack mrkdwn for chat.postMessage / chat.update text. */
export function markdownToSlackMrkdwn(input: string): string {
  if (!input) return "";

  const fences: string[] = [];
  const codes: string[] = [];
  const bolds: string[] = [];
  const italics: string[] = [];
  const strikes: string[] = [];
  const links: string[] = [];

  // 1. Protect fenced code blocks (``` ... ```), optional language tag on opener.
  let text = input.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, body: string) => {
    const idx = fences.length;
    fences.push("```\n" + String(body).replace(/\n$/, "") + "\n```");
    return FENCE_PH(idx);
  });

  // 2. Protect inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const idx = codes.length;
    codes.push("`" + body + "`");
    return CODE_PH(idx);
  });

  // 3. Links: [label](https://...) → <url|label>
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    const idx = links.length;
    links.push(`<${url}|${escapeMrkdwnPlain(label)}>`);
    return LINK_PH(idx);
  });

  // 4. Headings → bold line (placeholder so later emphasis rules cannot touch markers).
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, title: string) => {
    const idx = bolds.length;
    bolds.push(escapeMrkdwnPlain(title.trim()));
    return BOLD_PH(idx);
  });

  // 5. Bold (** / __) before italic so markers do not collide.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => {
    const idx = bolds.length;
    bolds.push(escapeMrkdwnPlain(inner));
    return BOLD_PH(idx);
  });
  text = text.replace(/__([^_\n]+)__/g, (_m, inner: string) => {
    const idx = bolds.length;
    bolds.push(escapeMrkdwnPlain(inner));
    return BOLD_PH(idx);
  });

  // 6. Italic (* / _) — single markers only.
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, (_m, pre: string, inner: string) => {
    const idx = italics.length;
    italics.push(escapeMrkdwnPlain(inner));
    return `${pre}${ITALIC_PH(idx)}`;
  });
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, (_m, pre: string, inner: string) => {
    const idx = italics.length;
    italics.push(escapeMrkdwnPlain(inner));
    return `${pre}${ITALIC_PH(idx)}`;
  });

  // 7. Strikethrough ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, (_m, inner: string) => {
    const idx = strikes.length;
    strikes.push(escapeMrkdwnPlain(inner));
    return STRIKE_PH(idx);
  });

  // 8. Escape bare &, <, > outside already-formed Slack tokens / placeholders.
  text = escapeMrkdwnOutsideTokens(text);

  // 9. Restore protected regions as Slack mrkdwn.
  text = text.replace(/\u0000L(\d+)\u0000/g, (_m, n: string) => links[Number(n)] ?? "");
  text = text.replace(/\u0000B(\d+)\u0000/g, (_m, n: string) => {
    const inner = bolds[Number(n)];
    return inner == null ? "" : `*${inner}*`;
  });
  text = text.replace(/\u0000I(\d+)\u0000/g, (_m, n: string) => {
    const inner = italics[Number(n)];
    return inner == null ? "" : `_${inner}_`;
  });
  text = text.replace(/\u0000S(\d+)\u0000/g, (_m, n: string) => {
    const inner = strikes[Number(n)];
    return inner == null ? "" : `~${inner}~`;
  });
  text = text.replace(/\u0000F(\d+)\u0000/g, (_m, n: string) => fences[Number(n)] ?? "");
  text = text.replace(/\u0000C(\d+)\u0000/g, (_m, n: string) => codes[Number(n)] ?? "");

  return text;
}

function escapeMrkdwnPlain(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape & < > except inside already-formed Slack tokens and private placeholders.
 */
function escapeMrkdwnOutsideTokens(value: string): string {
  const tokens: string[] = [];
  // Protect existing angle tokens and our \u0000...\u0000 placeholders.
  const protectedText = value
    .replace(/<[^>\n]+>/g, (token) => {
      const idx = tokens.length;
      tokens.push(token);
      return `\u0000T${idx}\u0000`;
    })
    .replace(/\u0000[A-Z]\d+\u0000/g, (token) => {
      const idx = tokens.length;
      tokens.push(token);
      return `\u0000T${idx}\u0000`;
    });
  const escaped = escapeMrkdwnPlain(protectedText);
  return escaped.replace(/\u0000T(\d+)\u0000/g, (_m, n: string) => tokens[Number(n)] ?? "");
}
