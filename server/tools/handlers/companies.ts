import type { ToolHandler } from "../contracts";

/**
 * Companies handler extracted from bridge-tools.ts. Delegates every action to
 * the canonical companyStorage boundary. Behavior, result shapes, and error
 * handling are preserved verbatim; public identity (tool-registry),
 * ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules.
 */
export const companiesHandler: ToolHandler = async (args) => {
  try {
    const { companyStorage } = await import("../../company-storage");
    const action = String(args.action || "list");
    if (action === "list") return { result: JSON.stringify(await companyStorage.list(args.query), null, 2) };
    const company = args.id ? await companyStorage.resolve(String(args.id)) : null;
    if (action === "get") {
      if (!company) return { result: "Company not found", error: true };
      return { result: JSON.stringify({ ...company, people: await companyStorage.listPeople(company.id), opportunities: await companyStorage.listOpportunities(company.id) }, null, 2) };
    }
    if (action === "create") {
      if (!args.name) return { result: "Missing company name", error: true };
      const created = await companyStorage.create(args);
      return { result: `Company created: ${created.name} @company:${created.id}` };
    }
    if (!company) return { result: "Company not found. Provide id or exact name.", error: true };
    if (action === "update") {
      const updated = await companyStorage.update(company.id, args);
      return { result: `Company updated: ${updated.name} @company:${updated.id}` };
    }
    if (action === "delete") {
      await companyStorage.delete(company.id);
      return { result: `Company deleted: ${company.name}` };
    }
    if (action === "add_opportunity" || action === "remove_opportunity") {
      if (typeof args.opportunityId !== "number") return { result: "Missing opportunityId", error: true };
      if (action === "add_opportunity") {
        await companyStorage.addOpportunity(company.id, args.opportunityId);
        return { result: `Added opportunity ${args.opportunityId} to @company:${company.id}` };
      }
      await companyStorage.removeOpportunity(company.id, args.opportunityId);
      return { result: `Removed opportunity ${args.opportunityId} from @company:${company.id}` };
    }
    if (!args.personId) return { result: "Missing personId", error: true };
    if (action === "add_person") {
      await companyStorage.addPerson(company.id, String(args.personId));
      return { result: `Added @person:${args.personId} to @company:${company.id}` };
    }
    if (action === "remove_person") {
      await companyStorage.removePerson(company.id, String(args.personId));
      return { result: `Removed @person:${args.personId} from @company:${company.id}` };
    }
    return { result: `Unknown companies action: ${action}`, error: true };
  } catch (err: any) {
    return { result: `Companies tool error: ${err.message}`, error: true };
  }
};
