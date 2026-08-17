/**
 * Convert common Markdown (model/web default) into Slack mrkdwn.
 * Sole outbound formatting boundary for Slack transport text.
 *
 * Slack mrkdwn differs from Markdown:
 * - bold is *text* (not **text**)
 * - italic is _text_ (not *text*)
 * - strike is ~text~ (not ~~text~~)
 * - links are <url|label>
 * - &, <, > must be escaped outside link/user/channel tokens
 */

const PH = (kind: string, index: number) => `\u0000${kind}${index}\u0000`;

export function markdownToSlackMrkdwn(input: string): string {
  if (!input) return "";

  const fences: string[] = [];
  const inlines: string[] = [];
  const links: string[] = [];
  const bolds: string[] = [];
  const boldItalics: string[] = [];

  let text = input.replace(/\r\n/g, "\n");

  // 1. Fenced code blocks — preserve body.
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, _lang: string, body: string) => {
    const index = fences.length;
    const content = body.replace(/\n$/, "");
    fences.push("```\n" + content + (content.endsWith("\n") ? "" : "\n") + "```");
    return PH("FENCE", index);
  });

  // 2. Inline code — same in both dialects.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const index = inlines.length;
    inlines.push("`" + body + "`");
    return PH("CODE", index);
  });

  // 3. Markdown links → Slack <url|label>
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    const index = links.length;
    const safeLabel = escapeMrkdwnPlain(label).replace(/\|/g, " ");
    links.push(`<${url}|${safeLabel}>`);
    return PH("LINK", index);
  });

  // 4. Headings → bold line (placeholder so italic pass cannot rewrite)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => {
    const index = bolds.length;
    bolds.push(`*${title.trim()}*`);
    return PH("BOLD", index);
  });

  // 5. Bold+italic ***text*** / ___text___ before simpler forms
  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_m, body: string) => {
    const index = boldItalics.length;
    boldItalics.push(`*_${body}_*`);
    return PH("BI", index);
  });
  text = text.replace(/___([^_\n]+)___/g, (_m, body: string) => {
    const index = boldItalics.length;
    boldItalics.push(`*_${body}_*`);
    return PH("BI", index);
  });

  // 6. Bold **text** / __text__ → placeholders (Slack *text*)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => {
    const index = bolds.length;
    bolds.push(`*${body}*`);
    return PH("BOLD", index);
  });
  text = text.replace(/__([^_\n]+)__/g, (_m, body: string) => {
    const index = bolds.length;
    bolds.push(`*${body}*`);
    return PH("BOLD", index);
  });

  // 7. Strikethrough ~~text~~ → ~text~
  text = text.replace(/~~([^~\n]+)~~/g, (_m, body: string) => `~${body}~`);

  // 8. Remaining Markdown italic *text* → Slack _text_
  //    Underscore italic _text_ is already Slack-native; leave it.
  text = text.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!?;:])/g, (_m, lead: string, body: string) => {
    return `${lead}_${body}_`;
  });

  // 9. Unordered lists (- * +) → bullet. Asterisk list markers only at line start
  //    after bold/italic conversion so leftover list "*" is safe.
  text = text.replace(/^(\s*)[-+]\s+/gm, "$1• ");
  text = text.replace(/^(\s*)\*\s+/gm, "$1• ");

  // 10. Escape &, <, > outside placeholders
  text = escapeMrkdwnOutsidePlaceholders(text);

  // 11. Restore protected spans
  text = text.replace(/\u0000BI(\d+)\u0000/g, (_m, i) => boldItalics[Number(i)] ?? "");
  text = text.replace(/\u0000BOLD(\d+)\u0000/g, (_m, i) => bolds[Number(i)] ?? "");
  text = text.replace(/\u0000LINK(\d+)\u0000/g, (_m, i) => links[Number(i)] ?? "");
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => inlines[Number(i)] ?? "");
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "");

  return text;
}

function escapeMrkdwnPlain(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMrkdwnOutsidePlaceholders(value: string): string {
  const parts = value.split(/(\u0000(?:FENCE|CODE|LINK|BOLD|BI)\d+\u0000)/g);
  return parts
    .map((part) => (part.startsWith("\u0000") ? part : escapeMrkdwnPlain(part)))
    .join("");
}
