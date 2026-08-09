import { safeStringify } from "../utils/safe-stringify";
import { agendaDefinitionStorage } from "../agenda-storage";
import type { ToolHandler } from "./contracts";

export const handleAgendas: ToolHandler = async (args) => {
  const action = String(args.action || "list");
  try {
    if (action === "list" || action === "search") {
      const query = action === "search" ? String(args.query || "").trim() : undefined;
      if (action === "search" && !query) return { result: "Missing query for agendas.search", error: true };
      const agendas = await agendaDefinitionStorage.list(query, Number(args.limit) || 50);
      return { result: safeStringify({ total: agendas.length, agendas }, { label: "bridge.agendas.list" }) };
    }
    if (action === "get") {
      if (!args.id) return { result: "Missing id for agendas.get", error: true };
      const agenda = await agendaDefinitionStorage.get(String(args.id));
      return agenda
        ? { result: safeStringify(agenda, { label: "bridge.agendas.get" }) }
        : { result: `Agenda "${args.id}" not found`, error: true };
    }
    if (action === "create") {
      if (!args.name || !Array.isArray(args.items)) return { result: "agendas.create requires name and items", error: true };
      const agenda = await agendaDefinitionStorage.create({
        name: String(args.name),
        description: typeof args.description === "string" ? args.description : undefined,
        items: args.items,
      });
      return { result: safeStringify(agenda, { label: "bridge.agendas.create" }) };
    }
    if (action === "update") {
      if (!args.id) return { result: "Missing id for agendas.update", error: true };
      const agenda = await agendaDefinitionStorage.update(String(args.id), {
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(Array.isArray(args.items) ? { items: args.items } : {}),
        ...(Array.isArray(args.clearFields) ? { clearFields: args.clearFields } : {}),
      });
      return agenda
        ? { result: safeStringify(agenda, { label: "bridge.agendas.update" }) }
        : { result: `Agenda "${args.id}" not found`, error: true };
    }
    if (action === "delete") {
      if (!args.id) return { result: "Missing id for agendas.delete", error: true };
      const deleted = await agendaDefinitionStorage.delete(String(args.id));
      return deleted
        ? { result: `Agenda ${args.id} deleted.` }
        : { result: `Agenda "${args.id}" not found`, error: true };
    }
    return { result: `Unknown agendas action: ${action}. Available: list, search, get, create, update, delete`, error: true };
  } catch (error) {
    return { result: `agendas.${action} failed: ${error instanceof Error ? error.message : String(error)}`, error: true };
  }
};
