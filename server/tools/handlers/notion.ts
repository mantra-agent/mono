import type { ToolHandler, ToolHandlerResult } from "../contracts";

/**
 * Notion handler extracted from bridge-tools.ts, together with its per-action
 * helpers. Every action delegates to the canonical notion integration module
 * and resolves the target account through the same local resolver. Behavior,
 * result shapes, and error handling are preserved verbatim; public identity
 * (tool-registry), ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules.
 */

type NotionResolveAccountId = (a: Record<string, any>) => Promise<{ id: string } | { error: string }>;
type NotionModule = typeof import("../../notion");

async function handleNotionStatus(notion: NotionModule): Promise<ToolHandlerResult> {
  const accounts = await notion.listNotionAccounts();
  if (accounts.length === 0) return { result: "Notion: no accounts connected. Add one in Settings > Integrations." };
  const lines = accounts.map(a => `- **${a.workspaceName}** (${a.label})`);
  return { result: `Notion: ${accounts.length} account(s) connected:\n${lines.join("\n")}` };
}

async function handleNotionSearch(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const query = args.query || "";
  const pages = await notion.searchPages(resolved.id, query, args.limit || 10);
  if (pages.length === 0) return { result: query ? `No Notion pages found for "${query}"` : "No pages found in Notion." };
  const lines = pages.map((p: any) => {
    const title = p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "(untitled)";
    const lastEdited = p.last_edited_time ? ` — edited ${new Date(p.last_edited_time).toLocaleDateString()}` : "";
    return `- **${title}** (id: ${p.id})${lastEdited}`;
  });
  return { result: `Found ${pages.length} pages:\n${lines.join("\n")}` };
}

async function handleNotionGetPage(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const pageId = args.id;
  if (!pageId) return { result: "Missing page id", error: true };
  const page = await notion.getPage(resolved.id, pageId);
  const props = page.properties || {};
  const title = (props as any).title?.title?.[0]?.plain_text || (props as any).Name?.title?.[0]?.plain_text || "(untitled)";
  const lastEdited = page.last_edited_time ? new Date(page.last_edited_time as any).toLocaleString() : "unknown";
  const propLines = Object.entries(props)
    .filter(([k]) => k !== "title" && k !== "Name")
    .slice(0, 10)
    .map(([k, v]: [string, any]) => {
      if (v.type === "rich_text") return `  ${k}: ${v.rich_text?.[0]?.plain_text || ""}`;
      if (v.type === "select") return `  ${k}: ${v.select?.name || ""}`;
      if (v.type === "multi_select") return `  ${k}: ${v.multi_select?.map((s: any) => s.name).join(", ") || ""}`;
      if (v.type === "date") return `  ${k}: ${v.date?.start || ""}`;
      if (v.type === "number") return `  ${k}: ${v.number ?? ""}`;
      if (v.type === "checkbox") return `  ${k}: ${v.checkbox ? "Yes" : "No"}`;
      return `  ${k}: (${v.type})`;
    });
  return { result: `**${title}**\nLast edited: ${lastEdited}\n${propLines.length ? "Properties:\n" + propLines.join("\n") : ""}` };
}

async function handleNotionGetContent(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const pageId = args.id;
  if (!pageId) return { result: "Missing page id", error: true };
  const blocks = await notion.getPageContent(resolved.id, pageId);
  const lines = blocks.slice(0, 50).map((b: any) => {
    const type = b.type;
    const content = b[type];
    if (!content) return `[${type}]`;
    if (content.rich_text) {
      const text = content.rich_text.map((t: any) => t.plain_text).join("");
      if (type === "heading_1") return `# ${text}`;
      if (type === "heading_2") return `## ${text}`;
      if (type === "heading_3") return `### ${text}`;
      if (type === "bulleted_list_item") return `- ${text}`;
      if (type === "numbered_list_item") return `1. ${text}`;
      if (type === "to_do") return `${content.checked ? "[x]" : "[ ]"} ${text}`;
      return text;
    }
    if (type === "divider") return "---";
    if (type === "image") return `[image: ${content.external?.url || content.file?.url || "embedded"}]`;
    return `[${type}]`;
  });
  if (blocks.length > 50) lines.push(`... and ${blocks.length - 50} more blocks`);
  return { result: lines.join("\n") || "(empty page)" };
}

async function handleNotionListDatabases(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const dbs = await notion.searchDatabases(resolved.id, args.query, args.limit || 10);
  if (dbs.length === 0) return { result: "No databases found in Notion." };
  const lines = dbs.map((db: any) => {
    const title = db.title?.[0]?.plain_text || "(untitled)";
    return `- **${title}** (id: ${db.id})`;
  });
  return { result: `Found ${dbs.length} databases:\n${lines.join("\n")}` };
}

async function handleNotionQueryDatabase(args: Record<string, any>, resolveAccountId: NotionResolveAccountId, notion: NotionModule): Promise<ToolHandlerResult> {
  const resolved = await resolveAccountId(args);
  if ("error" in resolved) return { result: resolved.error, error: true };
  const dbId = args.id;
  if (!dbId) return { result: "Missing database id", error: true };
  const { results, hasMore } = await notion.queryDatabase(resolved.id, dbId, { pageSize: args.limit || 20 });
  if (results.length === 0) return { result: "No entries in this database." };
  const lines = results.map((row: any) => {
    const props = row.properties || {};
    const title = Object.values(props).find((v: any) => v.type === "title") as any;
    const name = title?.title?.[0]?.plain_text || "(untitled)";
    return `- **${name}** (id: ${row.id})`;
  });
  const more = hasMore ? `\n(more results available)` : "";
  return { result: `${results.length} entries:\n${lines.join("\n")}${more}` };
}

export const notionHandler: ToolHandler = async (args) => {
  const action = args.action || "status";

  try {
    const notionModule = await import("../../notion");

    const resolveAccountId = async (a: Record<string, any>): Promise<{ id: string } | { error: string }> => {
      const accounts = await notionModule.listNotionAccounts();
      if (accounts.length === 0) return { error: "No Notion account connected. Add one in Settings > Integrations." };
      if (a.account) {
        const match = accounts.find(acc => acc.id === a.account || acc.label.toLowerCase() === a.account.toLowerCase() || acc.workspaceName.toLowerCase().includes(a.account.toLowerCase()));
        if (!match) return { error: `Notion account "${a.account}" not found. Connected accounts: ${accounts.map(acc => acc.label).join(", ")}` };
        return { id: match.id };
      }
      return { id: accounts[0].id };
    };

    const notionActionHandlers: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      status: (a) => handleNotionStatus(notionModule),
      search: (a) => handleNotionSearch(a, resolveAccountId, notionModule),
      get_page: (a) => handleNotionGetPage(a, resolveAccountId, notionModule),
      get_content: (a) => handleNotionGetContent(a, resolveAccountId, notionModule),
      list_databases: (a) => handleNotionListDatabases(a, resolveAccountId, notionModule),
      query_database: (a) => handleNotionQueryDatabase(a, resolveAccountId, notionModule),
    };

    const handler = notionActionHandlers[action];
    if (!handler) return { result: `Unknown notion action: ${action}. Available: status, search, get_page, get_content, list_databases, query_database`, error: true };
    return await handler(args);
  } catch (err: any) {
    return { result: `Notion tool error: ${err.message}`, error: true };
  }
};
