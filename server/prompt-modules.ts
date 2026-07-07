import { storage } from "./storage";
import { db } from "./db";
import { skills, type InsertPromptModule, type PromptModule } from "@shared/schema";
import { PROMPT_MODULE_BOOTSTRAP_FIXTURES, type PromptModuleBootstrapFixture } from "./prompt-module-defaults";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { PROMPT_MODULE_KEYS, PROMPT_MODULE_MANIFEST, isPromptModuleKey } from "./prompt-module-registry";
import { inArray } from "drizzle-orm";
import { createLogger } from "./log";

const log = createLogger("PromptModules");

export const INTERNAL_PROMPT_SKILLS = PROMPT_MODULE_KEYS;


function nameForKey(key: string): string {
  return key.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function promptModuleValues(input: PromptModuleBootstrapFixture | typeof skills.$inferSelect, migratedFrom: "bootstrap-fixture" | "skills"): InsertPromptModule {
  if (!isPromptModuleKey(input.name)) {
    throw new Error(`Unknown internal prompt module key: ${input.name}`);
  }
  const manifest = PROMPT_MODULE_MANIFEST[input.name];
  return {
    key: input.name,
    name: nameForKey(input.name),
    description: manifest.description || input.description || `Internal prompt module migrated from ${migratedFrom} ${input.name}.`,
    domain: manifest.domain,
    prompt: input.process,
    outputSpec: input.outputSpec ?? "",
    outputSchema: {},
    status: "status" in input && input.status === "deprecated" ? "deprecated" : "active",
    version: input.version || "1.0",
    sourceSkillName: input.name,
    scope: "global",
    metadata: {
      migratedFrom,
      ownerSystem: manifest.ownerSystem,
      callSites: manifest.callSites,
      manifestDescription: manifest.description,
      originalCategory: input.category,
      originalActivity: input.activity || manifest.activity,
      originalWhenToUse: input.whenToUse,
    },
  };
}

function skillToPromptModule(skill: typeof skills.$inferSelect): InsertPromptModule {
  return promptModuleValues(skill, "skills");
}

function defaultToPromptModule(def: PromptModuleBootstrapFixture): InsertPromptModule {
  return promptModuleValues(def, "bootstrap-fixture");
}

function internalPromptDefault(key: string): PromptModuleBootstrapFixture | undefined {
  return PROMPT_MODULE_BOOTSTRAP_FIXTURES.find(def => def.name === key && isPromptModuleKey(def.name));
}

export function promptModuleActivity(module: PromptModule, fallback = ACTIVITY_FRAMING): string {
  const metadata = module.metadata as { originalActivity?: unknown } | null;
  return typeof metadata?.originalActivity === "string" && metadata.originalActivity.length > 0 ? metadata.originalActivity : fallback;
}

export async function getPromptModule(key: string): Promise<PromptModule> {
  const module = await storage.getPromptModuleByKey(key);
  if (!module) {
    log.error(`Prompt module missing; runtime fetch failed closed for key=${key}. Run the authorized prompt-module backfill/admin repair path if this module should exist.`);
    throw new Error(`Prompt module not found: ${key}. Runtime prompt-module fetch is DB-authoritative and does not fall back to skills or code defaults.`);
  }
  return module;
}

export async function getPromptModulePrompt(key: string): Promise<string> {
  const module = await getPromptModule(key);
  return module.prompt;
}

export async function getPromptModulePromptEntry(key: string, fallbackActivity = ACTIVITY_FRAMING): Promise<{ prompt: string; activity: string }> {
  const module = await getPromptModule(key);
  return { prompt: module.prompt, activity: promptModuleActivity(module, fallbackActivity) };
}

export async function backfillPromptModulesFromSkills(): Promise<{ created: string[]; skipped: string[]; missing: string[] }> {
  const skillRows = await db.select().from(skills).where(inArray(skills.name, [...INTERNAL_PROMPT_SKILLS]));
  const byName = new Map(skillRows.map(skill => [skill.name, skill]));
  const created: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const key of INTERNAL_PROMPT_SKILLS) {
    const skill = byName.get(key);
    if (!skill) {
      const def = internalPromptDefault(key);
      if (!def) {
        missing.push(key);
        continue;
      }
      const existing = await storage.getPromptModuleByKey(key);
      if (existing) {
        skipped.push(key);
        continue;
      }
      await storage.createPromptModule(defaultToPromptModule(def));
      created.push(key);
      continue;
    }
    const existing = await storage.getPromptModuleByKey(key);
    if (existing) {
      skipped.push(key);
      continue;
    }
    await storage.createPromptModule(skillToPromptModule(skill));
    created.push(key);
  }

  if (created.length || missing.length) {
    log.log(`Prompt module backfill created=${created.length} skipped=${skipped.length} missing=${missing.length}`);
  }

  return { created, skipped, missing };
}

export async function backfillPromptModule(key: string): Promise<PromptModule | undefined> {
  const existing = await storage.getPromptModuleByKey(key);
  if (existing) return existing;
  log.warn(`Prompt module backfill for single key is disabled at runtime: ${key}`);
  return undefined;
}
