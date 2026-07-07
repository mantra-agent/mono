import { BaseDocumentStore } from "./base";
import { createLogger } from "../log";

const parseLog = createLogger("StoreBeliefs");

export interface BeliefEvidence {
  type: "memory" | "strategy" | "observation";
  id: string;
  summary: string;
}

export interface Belief {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  evidence: BeliefEvidence[];
  status: "active" | "uncertain" | "invalidated";
  principleRef: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function docToBelief(doc: { content: string; metadata: Record<string, unknown> }): Belief {
  const meta = doc.metadata;
  return {
    id: String(meta.id || ""),
    claim: String(meta.claim || ""),
    domain: String(meta.domain || ""),
    confidence: Number(meta.confidence ?? 0.5),
    evidence: (meta.evidence as BeliefEvidence[]) || [],
    status: (String(meta.status || "active") as Belief["status"]),
    principleRef: String(meta.principleRef || ""),
    tags: (meta.tags as string[]) || [],
    createdAt: String(meta.createdAt || new Date().toISOString()),
    updatedAt: String(meta.updatedAt || new Date().toISOString()),
  };
}

export class FileBeliefStorage extends BaseDocumentStore<Belief> {
  constructor() {
    super({
      docType: "belief",
      logPrefix: "StoreBeliefs",
      pathPrefix: "beliefs",
      getTitle: (b) => b.claim,
      docToEntity: docToBelief,
    });
  }

  async create(input: {
    claim: string;
    domain: string;
    confidence?: number;
    evidence?: BeliefEvidence[];
    status?: Belief["status"];
    principleRef?: string;
    tags?: string[];
  }): Promise<Belief> {
    const now = this.nowISO();
    const belief: Belief = {
      id: this.newId(),
      claim: input.claim,
      domain: input.domain,
      confidence: input.confidence ?? 0.5,
      evidence: input.evidence || [],
      status: input.status || "active",
      principleRef: input.principleRef || "",
      tags: input.tags || [],
      createdAt: now,
      updatedAt: now,
    };

    await this.persistAndSync(belief, "create", " domain=" + belief.domain + " status=" + belief.status);
    return belief;
  }

  async update(id: string, updates: Partial<Omit<Belief, "id" | "createdAt">>): Promise<Belief | null> {
    return this.updateEntity(id, updates);
  }

  async updateConfidence(id: string, confidence: number): Promise<Belief | null> {
    this.log.log("updateConfidence id=" + id + " confidence=" + confidence);
    return this.update(id, { confidence });
  }

  async updateStatus(id: string, status: Belief["status"]): Promise<Belief | null> {
    this.log.log("updateStatus id=" + id + " status=" + status);
    return this.update(id, { status });
  }
}

export const fileBeliefStorage = new FileBeliefStorage();
