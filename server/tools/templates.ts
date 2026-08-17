import { safeStringify } from "../utils/safe-stringify";
import { documentTemplateStorage } from "../document-template-storage";
import type { ToolHandler } from "./contracts";

export const handleTemplates: ToolHandler = async (args) => {
  const action = String(args.action || "list");
  try {
    if (action === "list" || action === "search") {
      const query = action === "search" ? String(args.query || "").trim() : undefined;
      if (action === "search" && !query) return { result: "Missing query for templates.search", error: true };
      const templates = await documentTemplateStorage.list(query);
      return { result: safeStringify({ total: templates.length, templates }, { label: "bridge.templates.list" }) };
    }
    if (action === "get") {
      if (!args.id) return { result: "Missing id for templates.get", error: true };
      const template = await documentTemplateStorage.get(String(args.id));
      return template
        ? { result: safeStringify(template, { label: "bridge.templates.get" }) }
        : { result: `Template "${args.id}" not found`, error: true };
    }
    if (action === "resolve") {
      const skill = typeof args.skill === "string" ? args.skill : typeof args.skillName === "string" ? args.skillName : "";
      const key = typeof args.key === "string" ? args.key : "";
      if (!skill || !key) return { result: "templates.resolve requires skill and key", error: true };
      const resolved = await documentTemplateStorage.resolve(skill, key);
      return resolved
        ? { result: safeStringify(resolved, { label: "bridge.templates.resolve" }) }
        : { result: "template_unavailable", error: true };
    }
    if (action === "update") {
      if (!args.id) return { result: "Missing id for templates.update", error: true };
      const template = await documentTemplateStorage.update(String(args.id), {
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.pageId === "string" ? { pageId: args.pageId } : {}),
        ...(typeof args.status === "string" ? { status: args.status as "active" | "deprecated" } : {}),
      });
      return template
        ? { result: safeStringify(template, { label: "bridge.templates.update" }) }
        : { result: `Template "${args.id}" not found`, error: true };
    }
    if (action === "create") {
      if (!args.id || !args.name || !args.pageId) {
        return { result: "templates.create requires id, name, and pageId", error: true };
      }
      const template = await documentTemplateStorage.create({
        id: String(args.id),
        name: String(args.name),
        pageId: String(args.pageId),
        ...(typeof args.status === "string" ? { status: args.status as "active" | "deprecated" } : {}),
      });
      return { result: safeStringify(template, { label: "bridge.templates.create" }) };
    }
    if (action === "bind") {
      if (!args.skillId || !args.key || !args.templateId) {
        return { result: "templates.bind requires skillId, key, and templateId", error: true };
      }
      const binding = await documentTemplateStorage.bind(String(args.skillId), String(args.key), String(args.templateId));
      return { result: safeStringify(binding, { label: "bridge.templates.bind" }) };
    }
    return {
      result: `Unknown templates action: ${action}. Available: list, get, search, resolve, create, update, bind`,
      error: true,
    };
  } catch (error) {
    return {
      result: `templates.${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      error: true,
    };
  }
};
