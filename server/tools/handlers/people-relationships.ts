import { resolvePersonId } from "../shared/person";
import type { Mobilization, RelationshipProfile, NetworkProfile } from "../../people-storage";
import type { ToolHandlerResult } from "../contracts";

/**
 * People relationship-intelligence handlers extracted from bridge-tools.ts:
 * relationship/network profiles, social capital, commitments, ask-routing,
 * relationship memories, and enrichment prompts. Behavior, result shapes, and
 * error handling are preserved verbatim; person resolution stays on the shared
 * resolvePersonId boundary, and public identity (tool-registry),
 * ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules. Notes,
 * interactions, core mutations, and imports remain in bridge-tools until their
 * own extraction slices.
 */

async function handleUpdateRelationshipProfile(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const rp = person.relationshipProfile || {};
  if (args.temperature || args.momentum || args.status) {
    rp.state = {
      temperature: args.temperature || rp.state?.temperature || "warm",
      momentum: args.momentum || rp.state?.momentum || "steady",
      status: args.status || rp.state?.status || "active",
    };
  }
  if (args.targetDays || args.flexDays || args.cadenceClass) {
    rp.cadence = {
      targetDays: args.targetDays ?? rp.cadence?.targetDays ?? 30,
      flexDays: args.flexDays ?? rp.cadence?.flexDays ?? 14,
      cadenceClass: args.cadenceClass || rp.cadence?.cadenceClass || "monthly",
    };
  }
  await peopleStorage.updatePerson(resolved.id, { relationshipProfile: rp as RelationshipProfile });
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({ category: "agent", event: "data:people_changed", payload: { source: "people_tool", action: "update_relationship_profile", personId: resolved.id, personName: resolved.name } });
  return { result: `Relationship profile updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handleUpdateNetworkProfile(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  if (args.expertise) np.expertise = Array.isArray(args.expertise) ? args.expertise : [args.expertise];
  if (args.domains) np.domains = Array.isArray(args.domains) ? args.domains : [args.domains];
  if (args.resources) np.resources = Array.isArray(args.resources) ? args.resources : [args.resources];
  if (args.canHelpWith) np.canHelpWith = Array.isArray(args.canHelpWith) ? args.canHelpWith : [args.canHelpWith];
  if (args.connections) np.connections = args.connections;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({ category: "agent", event: "data:people_changed", payload: { source: "people_tool", action: "update_network_profile", personId: resolved.id, personName: resolved.name } });
  return { result: `Network profile updated for ${resolved.name} [person:${resolved.id}]` };
}

async function handleUpdateCapital(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  const cap = np.capital || { balance: "balanced", depositsFromRay: [], depositsToRay: [] };
  if (args.balance) cap.balance = args.balance;
  if (args.deposit_from_ray) {
    cap.depositsFromRay.push(args.deposit_from_ray);
    cap.lastDeposit = new Date().toISOString();
  }
  if (args.deposit_to_ray) {
    cap.depositsToRay.push(args.deposit_to_ray);
    cap.lastDeposit = new Date().toISOString();
  }
  if (args.withdrawal) {
    cap.lastWithdrawal = new Date().toISOString();
  }
  np.capital = cap;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Social capital updated for ${resolved.name} [person:${resolved.id}]: balance=${cap.balance}` };
}

async function handleAddCommitment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const { randomBytes } = await import("crypto");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.description) return { result: "Missing commitment description", error: true };
  if (!args.direction || !["from_ray", "to_ray"].includes(args.direction)) return { result: "direction must be 'from_ray' or 'to_ray'", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  if (!np.commitments) np.commitments = [];
  const commitment = {
    id: randomBytes(4).toString("hex"),
    direction: args.direction as "from_ray" | "to_ray",
    description: args.description,
    status: "open" as const,
    createdAt: new Date().toISOString(),
  };
  np.commitments.push(commitment);
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Commitment added for ${resolved.name} [person:${resolved.id}]: "${args.description}" (${args.direction})` };
}

async function handleUpdateCommitment(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.commitmentId) return { result: "Missing commitmentId", error: true };
  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile || {};
  const commitment = np.commitments?.find(c => c.id === args.commitmentId);
  if (!commitment) return { result: `Commitment ${args.commitmentId} not found`, error: true };
  if (args.status && ["open", "fulfilled", "expired"].includes(args.status)) {
    commitment.status = args.status;
    if (args.status !== "open") commitment.resolvedAt = new Date().toISOString();
  }
  if (args.description) commitment.description = args.description;
  await peopleStorage.updatePerson(resolved.id, { networkProfile: np as NetworkProfile });
  return { result: `Commitment ${args.commitmentId} updated for ${resolved.name} [person:${resolved.id}]: status=${commitment.status}` };
}

async function handleAskRoute(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage, computeMobilization } = await import("../../people-storage");
  const query = (args.query || args.need || "").toLowerCase();
  if (!query) return { result: "Missing query — what do you need help with?", error: true };
  const allPeople = await peopleStorage.listPeople();
  const results: Array<{ name: string; id: string; score: number; expertise: string[]; mobilization: Mobilization | undefined; capital: string; reason: string }> = [];

  for (const entry of allPeople) {
    if (entry.cabinetLevel === "self" || entry.cabinetLevel === "agent" || entry.cabinetLevel === "user") continue;
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;
    const np = person.networkProfile;
    if (!np) continue;

    let score = 0;
    const matchReasons: string[] = [];

    for (const field of [np.expertise, np.domains, np.resources, np.canHelpWith] as (string[] | undefined)[]) {
      if (!field) continue;
      for (const item of field) {
        if (item.toLowerCase().includes(query) || query.includes(item.toLowerCase())) {
          score += 10;
          matchReasons.push(item);
        }
      }
    }

    if (np.connections) {
      for (const conn of np.connections) {
        const connStr = `${conn.name} ${conn.relationship} ${conn.domain || ""}`.toLowerCase();
        if (connStr.includes(query)) {
          score += 5;
          matchReasons.push(`knows ${conn.name} (${conn.relationship})`);
        }
      }
    }

    if (score > 0) {
      const mob = computeMobilization(person);
      if (mob.ready) score += 20;
      else if (mob.blockers.length === 1) score += 5;
      const capBal = np.capital?.balance || "balanced";
      if (capBal === "invested") score += 10;
      else if (capBal === "balanced") score += 5;
      else if (capBal === "drawing") score -= 5;
      else if (capBal === "overdrawn") score -= 15;
      results.push({
        name: person.name,
        id: person.id,
        score,
        expertise: np.expertise || [],
        mobilization: mob,
        capital: capBal,
        reason: matchReasons.join(", "),
      });
    }
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aReady = a.mobilization?.ready ? 1 : 0;
    const bReady = b.mobilization?.ready ? 1 : 0;
    return bReady - aReady;
  });
  if (results.length === 0) return { result: "No one in the network matches that need." };

  const lines = results.slice(0, 5).map((r, i) => {
    let line = `${i + 1}. **${r.name}** (id: ${r.id}) — ${r.reason}`;
    const mob = r.mobilization;
    if (mob) {
      line += `\n   Capital: ${r.capital}. Mobilization: ${mob.ready ? "ready" : "not ready"}`;
      if (!mob.ready && mob.blockers.length > 0) {
        line += `\n   Blockers: ${mob.blockers.join("; ")}`;
      }
      if (mob.warmingPath) {
        line += `\n   → ${mob.warmingPath}`;
      }
    } else {
      line += `\n   Capital: ${r.capital}. Mobilization: unknown`;
    }
    return line;
  });

  return { result: `${results.length} people can help:\n\n${lines.join("\n\n")}` };
}

async function handleAddRelationshipMemory(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };
  if (!args.content) return { result: "Missing memory content", error: true };
  const validCategories = ["dynamic", "preference", "channel", "expertise", "network", "capital", "risk", "repair", "ritual", "opportunity"];
  const category = args.category || "dynamic";
  if (!validCategories.includes(category)) return { result: `Invalid category. Must be one of: ${validCategories.join(", ")}`, error: true };

  const { documentStorage } = await import("../../memory");
  const tags = ["relationship-model", `rm:${resolved.id}`, `rm-cat:${category}`];
  if (args.tags && Array.isArray(args.tags)) tags.push(...args.tags);

  const { randomBytes } = await import("crypto");
  const memId = randomBytes(4).toString("hex");
  await documentStorage.upsertDocument(
    "memory",
    `rm-${memId}`,
    `relationship-memories/${resolved.id}/${memId}.md`,
    `${resolved.name} — ${category}`,
    args.content,
    { tags, personId: resolved.id, personName: resolved.name, category, createdAt: new Date().toISOString() }
  );

  return { result: `Relationship memory added for ${resolved.name} [person:${resolved.id}] (category: ${category})` };
}

async function handleGetRelationshipMemories(args: Record<string, any>): Promise<ToolHandlerResult> {
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: "Person not found. Provide an id or name.", error: true };

  const { documentStorage } = await import("../../memory");
  const docs = await documentStorage.getDocumentsByType("memory");
  const memories = docs.filter(d => {
    const meta = d.metadata as any;
    const tags = meta?.tags || [];
    return tags.includes(`rm:${resolved.id}`);
  });

  if (memories.length === 0) return { result: `No relationship memories found for ${resolved.name} [person:${resolved.id}].` };

  const lines = memories.map(d => {
    const meta = d.metadata as any;
    const cat = (meta?.tags || []).find((t: string) => t.startsWith("rm-cat:"))?.replace("rm-cat:", "") || "uncategorized";
    return `- [${cat}] ${d.title}: ${(d.content || "").slice(0, 300)}${(d.content || "").length > 300 ? ` [ref:memory-${d.docId}]` : ""}`;
  });

  return { result: `${memories.length} relationship memories for ${resolved.name} [person:${resolved.id}]:\n${lines.join("\n")}` };
}

async function handleEnrichmentPrompt(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) {
    const allPeople = await peopleStorage.listPeople();
    const thinPeople = [];
    for (const entry of allPeople) {
      if (entry.cabinetLevel === "self" || entry.cabinetLevel === "agent" || entry.cabinetLevel === "user") continue;
      const person = await peopleStorage.getPerson(entry.id);
      if (!person) continue;
      const np = person.networkProfile;
      const hasExpertise = np?.expertise && np.expertise.length > 0;
      const hasConnections = np?.connections && np.connections.length > 0;
      const hasCanHelpWith = np?.canHelpWith && np.canHelpWith.length > 0;
      if (!hasExpertise && !hasConnections && !hasCanHelpWith) {
        thinPeople.push({ id: person.id, name: person.name, cabinetLevel: person.cabinetLevel });
      }
    }
    if (thinPeople.length === 0) return { result: "All people have network data populated." };
    const lines = thinPeople.slice(0, 10).map(p => `- ${p.name} (id: ${p.id}, ${p.cabinetLevel})`);
    return { result: `${thinPeople.length} people with thin network data:\n${lines.join("\n")}\n\nUse enrichment_prompt with a specific person to get conversation prompts.` };
  }

  const person = await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: "Person not found.", error: true };
  const np = person.networkProfile;
  const missing: string[] = [];
  if (!np?.expertise?.length) missing.push("expertise");
  if (!np?.domains?.length) missing.push("domains");
  if (!np?.connections?.length) missing.push("connections");
  if (!np?.canHelpWith?.length) missing.push("what they can help with");
  if (!np?.capital) missing.push("social capital status");

  if (missing.length === 0) return { result: `${resolved.name}'s network profile is well populated.` };

  const prompts = [
    `Tell me about ${resolved.name}'s professional expertise and what domains they work in.`,
    `Who does ${resolved.name} know that might be useful? What connections do they have?`,
    `What could ${resolved.name} specifically help with if you needed something?`,
    `How would you describe the balance of favors between you and ${resolved.name}?`,
  ];

  return { result: `${resolved.name} [person:${resolved.id}] is missing: ${missing.join(", ")}.\n\nSuggested enrichment questions:\n${prompts.map((p, i) => `${i + 1}. "${p}"`).join("\n")}` };
}

/** action → handler map for the people relationship-intelligence surface. */
export const peopleRelationshipHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  update_relationship_profile: handleUpdateRelationshipProfile,
  update_network_profile: handleUpdateNetworkProfile,
  update_capital: handleUpdateCapital,
  add_commitment: handleAddCommitment,
  update_commitment: handleUpdateCommitment,
  ask_route: handleAskRoute,
  add_relationship_memory: handleAddRelationshipMemory,
  get_relationship_memories: handleGetRelationshipMemories,
  enrichment_prompt: handleEnrichmentPrompt,
};
