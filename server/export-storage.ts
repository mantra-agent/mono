// Use createLogger for logging ONLY
import { createLogger } from "./log";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { exportJobs, type ExportJob } from "@shared/schema";
import * as fsSync from "fs";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
// Storage module imports for document-backed domains
import { goalsService } from "./goals-service";
import {
  fileProjectStorage,
  fileTaskStorage,
  timerStorage,
  fileBeliefStorage,
  filePreferenceStorage,
  fileRuleStorage,
} from "./file-storage";
import { listHooks } from "./hook-storage";
import { peopleStorage } from "./people-storage";


const log = createLogger("ExportStorage");

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------
let _tableBootstrapped = false;

async function ensureTable(): Promise<void> {
  if (_tableBootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      current_domain TEXT,
      download_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON export_jobs(status)
  `);
  _tableBootstrapped = true;
}

// ---------------------------------------------------------------------------
// Job CRUD
// ---------------------------------------------------------------------------

export async function createExportJob(): Promise<ExportJob> {
  await ensureTable();
  const [job] = await db
    .insert(exportJobs)
    .values({ status: "pending", progress: 0 })
    .returning();
  return job;
}

export async function getExportJob(id: string): Promise<ExportJob | null> {
  await ensureTable();
  const [job] = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id));
  return job ?? null;
}

async function updateExportJob(
  id: string,
  updates: Partial<Pick<ExportJob, "status" | "progress" | "currentDomain" | "downloadUrl" | "error">>,
): Promise<void> {
  await db
    .update(exportJobs)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(exportJobs.id, id));
}

// ---------------------------------------------------------------------------
// TipTap JSON → plain markdown (simple recursive walk)
// ---------------------------------------------------------------------------

function tipTapToMarkdown(node: any, depth = 0): string {
  if (!node) return "";
  const indent = "  ".repeat(Math.max(0, depth - 1));

  switch (node.type) {
    case "doc":
      return (node.content || []).map((c: any) => tipTapToMarkdown(c, depth)).join("\n");

    case "paragraph": {
      const inner = (node.content || []).map((c: any) => tipTapToMarkdown(c, depth)).join("");
      return inner ? `${inner}\n` : "\n";
    }

    case "heading": {
      const level = node.attrs?.level ?? 1;
      const hashes = "#".repeat(Math.min(level, 6));
      const inner = (node.content || []).map((c: any) => tipTapToMarkdown(c, depth)).join("");
      return `${hashes} ${inner}\n`;
    }

    case "bulletList":
    case "orderedList": {
      const items = (node.content || []).map((c: any) => tipTapToMarkdown(c, depth + 1)).join("");
      return items;
    }

    case "listItem": {
      const inner = (node.content || [])
        .map((c: any) => tipTapToMarkdown(c, depth))
        .join("")
        .replace(/^\n+|\n+$/g, "");
      return `${indent}- ${inner}\n`;
    }

    case "blockquote": {
      const inner = (node.content || []).map((c: any) => tipTapToMarkdown(c, depth)).join("");
      return inner.split("\n").map((l: string) => `> ${l}`).join("\n") + "\n";
    }

    case "codeBlock": {
      const lang = node.attrs?.language ?? "";
      const code = (node.content || []).map((c: any) => c.text ?? "").join("");
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    case "horizontalRule":
      return "---\n";

    case "hardBreak":
      return "\n";

    case "text": {
      let text: string = node.text ?? "";
      if (node.marks) {
        for (const mark of node.marks) {
          if (mark.type === "bold") text = `**${text}**`;
          else if (mark.type === "italic") text = `_${text}_`;
          else if (mark.type === "code") text = `\`${text}\``;
          else if (mark.type === "link") text = `[${text}](${mark.attrs?.href ?? ""})`;
        }
      }
      return text;
    }

    default: {
      // Unknown node: recurse into children if present
      if (node.content) {
        return (node.content as any[]).map((c: any) => tipTapToMarkdown(c, depth)).join("");
      }
      return node.text ?? "";
    }
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _\-().]/g, "_").trim().replace(/\s+/g, "_") || "unnamed";
}

// ---------------------------------------------------------------------------
// Domain generators
// ---------------------------------------------------------------------------

async function genLibrary(dir: string): Promise<{ count: number }> {
  const pages = await db.execute(
    sql`SELECT id, title, plain_text_content, content, tags, status, one_liner, created_at, updated_at
        FROM library_pages ORDER BY created_at`
  );
  let count = 0;
  for (const row of pages.rows as any[]) {
    const name = safeName(row.title ?? "untitled");
    const body = row.plain_text_content
      ? String(row.plain_text_content)
      : row.content
        ? tipTapToMarkdown(row.content)
        : "";
    const tags = Array.isArray(row.tags) ? row.tags.join(", ") : (row.tags ?? "");
    const md =
      `# ${row.title ?? "Untitled"}\n\n` +
      (row.one_liner ? `> ${row.one_liner}\n\n` : "") +
      (tags ? `**Tags:** ${tags}\n\n` : "") +
      (row.status ? `**Status:** ${row.status}\n\n` : "") +
      `---\n\n${body}\n`;
    await writeFile(dir, `library/${name}-${row.id?.slice(0, 8) ?? "x"}.md`, md);
    count++;
  }
  return { count };
}

async function genPeople(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const index = await peopleStorage.listPeople();
    for (const entry of index) {
      const p = await peopleStorage.getPerson(entry.id);
      if (!p) continue;
      const tier = p.cabinetLevel ?? "network";
      const name = safeName(p.name ?? "unnamed");
      const interactions: any[] = p.interactions ?? [];
      const notes: any[] = p.notes ?? [];
      const contactInfo: any[] = p.contactInfo ?? [];
      const socialProfiles: any = p.socialProfiles ?? {};

      // Contact info — all types
      const contactMd = contactInfo.length
        ? contactInfo.map((c: any) => `- **${c.label || c.type}:** ${c.value}`).join("\n") + "\n"
        : "";

      // Social handles
      const socialLines = [
        socialProfiles.x ? `- **X / Twitter:** @${socialProfiles.x}` : "",
        socialProfiles.linkedin ? `- **LinkedIn:** ${socialProfiles.linkedin}` : "",
        socialProfiles.instagram ? `- **Instagram:** @${socialProfiles.instagram}` : "",
      ].filter(Boolean);
      const socialMd = socialLines.length ? socialLines.join("\n") + "\n" : "";

      const interactionMd = interactions.length
        ? `\n## Interactions\n\n` +
          interactions.map((i: any) =>
            `- **${i.type ?? "note"}** (${i.date ?? "?"}): ${i.summary ?? ""}` +
            (i.context ? ` — _${i.context}_` : "")
          ).join("\n") + "\n"
        : "";

      const notesMd = notes.length
        ? `\n## Notes\n\n` +
          notes.map((n: any) =>
            `### ${n.title ?? "Note"}` +
            (n.createdAt ? ` _(${n.createdAt})_` : "") +
            `\n${n.content ?? ""}`
          ).join("\n\n") + "\n"
        : "";

      const md =
        `# ${p.name ?? "Unnamed"}\n\n` +
        `**Tier:** ${tier}\n` +
        (p.role ? `**Role:** ${p.role}\n` : "") +
        (p.company ? `**Company:** ${p.company}\n` : "") +
        (p.relation ? `**Relation:** ${p.relation}\n` : "") +
        (p.introducedBy ? `**Introduced by:** ${p.introducedBy}\n` : "") +
        (p.birthday ? `**Birthday:** ${p.birthday}\n` : "") +
        (p.trust ? `**Trust:** ${p.trust}\n` : "") +
        (p.familiarity ? `**Familiarity:** ${p.familiarity}\n` : "") +
        (p.tags?.length ? `**Tags:** ${p.tags.join(", ")}\n` : "") +
        (contactMd ? `\n## Contact\n\n${contactMd}` : "") +
        (socialMd ? `\n## Social\n\n${socialMd}` : "") +
        "\n" +
        (p.aiSummary ?? p.quickSummary ?? "") +
        interactionMd +
        notesMd;
      await writeFile(dir, `people/${tier}/${name}.md`, md);
      count++;
    }
  } catch (err: any) {
    log.warn("genPeople failed:", err?.message);
    await writeFile(dir, "people/_ERRORS.md", `# People Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genProjects(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const projects = await fileProjectStorage.getProjects();
    for (const proj of projects) {
      const pname = safeName(proj.title ?? "project");
      const tasks = await fileTaskStorage.getTasks({ projectId: proj.id });
      const milestones = (proj.milestones ?? []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      const projNotes: any[] = proj.notes ?? [];

      const projMd =
        `# ${proj.title ?? "Project"}\n\n` +
        `**Status:** ${proj.status ?? ""}\n` +
        `**Priority:** ${proj.priority ?? ""}\n` +
        `**Owner:** ${proj.owner ?? ""}\n` +
        (proj.startDate ? `**Start:** ${proj.startDate}\n` : "") +
        (proj.dueDate ? `**Due:** ${proj.dueDate}\n` : "") +
        (proj.goalId ? `**Goal:** ${proj.goalId}\n` : "") +
        (proj.tags?.length ? `**Tags:** ${proj.tags.join(", ")}\n` : "") +
        "\n" +
        (proj.description ? `## Description\n\n${proj.description}\n\n` : "") +
        (proj.spec ? `## Spec\n\n${proj.spec}\n\n` : "") +
        (projNotes.length
          ? `## Notes\n\n` +
            projNotes.map((n: any) =>
              `### ${n.title ?? "Note"}\n${n.content ?? ""}`
            ).join("\n\n") + "\n"
          : "");

      const tasksMd =
        `# Tasks — ${proj.title}\n\n` +
        (tasks.length > 0
          ? tasks.map((t) => {
              const done = t.status === "done";
              const estimate = "";
              return (
                `- [${done ? "x" : " "}] **${t.title ?? "Task"}**${estimate}\n` +
                `  Status: ${t.status ?? ""} | Priority: ${t.priority ?? ""} | Effort: ${t.effort ?? ""} | Impact: ${t.impact ?? ""} | Owner: ${t.owner ?? ""}\n` +
                (t.deadline ? `  Deadline: ${t.deadline}\n` : "") +
                (t.description ? `  ${t.description}\n` : "") +
                (t.context ? `  Context: ${t.context}\n` : "") +
                (t.output ? `  Output: ${t.output}\n` : "") +
                (t.tags?.length ? `  Tags: ${t.tags.join(", ")}\n` : "")
              );
            }).join("\n")
          : "_No tasks_\n");

      const milestonesMd =
        `# Milestones — ${proj.title}\n\n` +
        (milestones.length > 0
          ? milestones.map((m: any, idx: number) =>
              `- [${m.status === "completed" ? "x" : " "}] **${m.name ?? "Milestone"}** (order: ${m.order ?? idx}, due: ${m.dueDate ?? "TBD"}, status: ${m.status ?? "planned"})`
            ).join("\n")
          : "_No milestones_");

      await writeFile(dir, `projects/${pname}/project.md`, projMd);
      await writeFile(dir, `projects/${pname}/tasks.md`, tasksMd);
      await writeFile(dir, `projects/${pname}/milestones.md`, milestonesMd);
      count++;
    }
  } catch (err: any) {
    log.warn("genProjects failed:", err?.message);
    await writeFile(dir, "projects/_ERRORS.md", `# Projects Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genGoals(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const index = await goalsService.listAll();
    // Build a map for tree rendering
    const goalMap: Record<string, typeof index[0]> = {};
    for (const entry of index) goalMap[entry.id] = entry;

    // Render tree recursively
    function renderTree(parentId: string | null, depth: number): string {
      const indent = "  ".repeat(depth);
      const children = index.filter(e => (e.parentId ?? null) === parentId);
      return children.map(e => {
        const status = e.status ?? "active";
        const horizonTag = e.horizon ? ` [${e.horizon}]` : "";
        const line = `${indent}- **${e.shortName}**${horizonTag} (${status})`;
        const sub = renderTree(e.id, depth + 1);
        return sub ? `${line}\n${sub}` : line;
      }).join("\n");
    }

    const treeMd =
      `# Goals — Life Tree\n\n` +
      renderTree(null, 0) + "\n";
    await writeFile(dir, "goals/_tree.md", treeMd);

    // Individual files per goal (full detail)
    for (const entry of index) {
      const g = await goalsService.get(entry.id);
      if (!g) continue;
      const tags = g.tags ?? [];
      const domain = tags[0] ?? "general";
      const name = safeName(g.shortName ?? "goal");
      const md =
        `# ${g.shortName ?? "Goal"}\n\n` +
        `**ID:** ${g.id}\n` +
        `**Domain:** ${domain}\n` +
        `**Horizon:** ${g.horizon ?? ""}\n` +
        `**Status:** ${g.status ?? ""}\n` +
        (g.parentId ? `**Parent:** ${goalMap[g.parentId]?.shortName ?? g.parentId}\n` : "") +
        (tags.length ? `**Tags:** ${tags.join(", ")}\n` : "") +
        "\n" +
        (g.description ? `## Description\n\n${g.description}\n` : "");
      await writeFile(dir, `goals/${domain}/${name}-${entry.id.slice(0, 8)}.md`, md);
      count++;
    }
  } catch (err: any) {
    log.warn("genGoals failed:", err?.message);
    await writeFile(dir, "goals/_ERRORS.md", `# Goals Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genSkills(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const skills = await db.execute(
      sql`SELECT name, description, process, when_to_use, output_spec, quality_criteria, checklist,
               category, activity, version, status, pinned_to_context, created_at
          FROM skills ORDER BY category, name`
    );
    for (const s of skills.rows as any[]) {
      const name = safeName(s.name ?? "skill");
      let checklistMd = "";
      try {
        const cl = Array.isArray(s.checklist) ? s.checklist : JSON.parse(s.checklist ?? "[]");
        if (cl.length > 0) {
          checklistMd = "## Quality Checklist\n\n" +
            cl.map((item: any) => {
              const w = item.weight != null ? ` (weight: ${item.weight})` : "";
              return `- [ ] ${item.check}${w}`;
            }).join("\n") + "\n\n";
        }
      } catch {}
      const md =
        `# ${s.name ?? "Skill"}\n\n` +
        `**Category:** ${s.category ?? ""}\n` +
        `**Version:** ${s.version ?? "1"}\n` +
        `**Status:** ${s.status ?? "draft"}\n` +
        (s.pinned_to_context ? `**Pinned:** yes\n` : "") +
        "\n" +
        (s.description ? `## Description\n\n${s.description}\n\n` : "") +
        (s.when_to_use ? `## When to Use\n\n${s.when_to_use}\n\n` : "") +
        (s.process ? `## Process\n\n${s.process}\n\n` : "") +
        (s.output_spec ? `## Output Spec\n\n${s.output_spec}\n\n` : "") +
        checklistMd +
        (s.quality_criteria ? `## Quality Criteria (legacy)\n\n${s.quality_criteria}\n` : "");
      await writeFile(dir, `skills/${name}.md`, md);
      count++;
    }
  } catch (err: any) {
    log.warn("genSkills failed:", err?.message);
    await writeFile(dir, "skills/_ERRORS.md", `# Skills Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genAutomation(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    // Timers are document-backed via timerStorage
    const timers = await timerStorage.getAll();
    const timersMd =
      `# Timers\n\n` +
      timers.map((t) => {
        const schedLines = (t.schedules ?? []).map((s: any) =>
          `  - ${s.frequency ?? "?"}` +
          (s.fireAt ? ` at ${s.fireAt}` : s.timeOfDay ? ` at ${s.timeOfDay}` : "") +
          (s.daysOfWeek ? ` on ${JSON.stringify(s.daysOfWeek)}` : "") +
          (s.cronExpression ? ` (cron: ${s.cronExpression})` : "") +
          (s.interval ? ` every ${s.interval}` : "")
        ).join("\n");
        return (
          `## ${t.name ?? "Timer"}\n` +
          `- **Type:** ${t.type ?? ""}\n` +
          `- **Enabled:** ${t.enabled ? "yes" : "no"}\n` +
          (schedLines ? `- **Schedules:**\n${schedLines}\n` : "") +
          (t.description ? `- **Description:** ${t.description}\n` : "")
        );
      }).join("\n");
    await writeFile(dir, "automation/timers.md", timersMd);

    // Hooks are in the system_hooks SQL table
    const hooks = await listHooks();
    const hooksMd =
      `# Hooks\n\n` +
      hooks.map((h: any) => {
        const conditionStr = h.condition ? JSON.stringify(h.condition, null, 2) : null;
        const actionStr = h.actionConfig ? JSON.stringify(h.actionConfig, null, 2) : null;
        return (
          `## ${h.name ?? "Hook"}\n` +
          `- **Event:** ${h.eventPattern ?? ""}\n` +
          `- **Action type:** ${h.actionType ?? ""}\n` +
          `- **Enabled:** ${h.enabled ? "yes" : "no"}\n` +
          (h.cooldownSeconds ? `- **Cooldown:** ${h.cooldownSeconds}s\n` : "") +
          (h.description ? `- **Description:** ${h.description}\n` : "") +
          (conditionStr ? `\n**Condition:**\n\`\`\`json\n${conditionStr}\n\`\`\`\n` : "") +
          (actionStr ? `\n**Action config:**\n\`\`\`json\n${actionStr}\n\`\`\`\n` : "")
        );
      }).join("\n");
    await writeFile(dir, "automation/hooks.md", hooksMd);
    count += timers.length + hooks.length;
  } catch (err: any) {
    log.warn("genAutomation failed:", err?.message);
    await writeFile(dir, "automation/_ERRORS.md", `# Automation Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

// genIntentions removed — intentions system deprecated

async function genDecisions(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const decisions = await db.execute(
      sql`SELECT id, title, description, status, traffic_light, closed_at,
               data_plain_text, scenarios_plain_text, plan_plain_text, created_at
          FROM decisions ORDER BY created_at DESC`
    );
    for (const d of decisions.rows as any[]) {
      const name = safeName(d.title ?? "decision");

      // Fetch updates for this decision
      const updates = await db.execute(
        sql`SELECT content, created_at FROM decision_updates
            WHERE decision_id = ${d.id} ORDER BY created_at ASC`
      );
      const updatesMd = updates.rows.length
        ? `## Updates\n\n` +
          (updates.rows as any[]).map((u: any) =>
            `### ${u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : "?"}\n${u.content ?? ""}`
          ).join("\n\n") + "\n\n"
        : "";

      // Fetch links for this decision
      const links = await db.execute(
        sql`SELECT target_type, target_id FROM decision_links WHERE decision_id = ${d.id}`
      );
      const linksMd = links.rows.length
        ? `## Links\n\n` +
          (links.rows as any[]).map((l: any) => `- ${l.target_type}: ${l.target_id}`).join("\n") + "\n\n"
        : "";

      const trafficLight = d.traffic_light;
      const trafficEmoji = trafficLight === "green" ? "🟢" : trafficLight === "yellow" ? "🟡" : trafficLight === "red" ? "🔴" : "";

      const md =
        `# ${d.title ?? "Decision"}\n\n` +
        `**Status:** ${d.status ?? ""}${trafficEmoji ? ` ${trafficEmoji}` : ""}\n` +
        (d.closed_at ? `**Closed:** ${new Date(d.closed_at).toISOString().slice(0, 10)}\n` : "") +
        "\n" +
        (d.description ? `> ${d.description}\n\n` : "") +
        (d.data_plain_text ? `## Data\n\n${d.data_plain_text}\n\n` : "") +
        (d.scenarios_plain_text ? `## Scenarios\n\n${d.scenarios_plain_text}\n\n` : "") +
        (d.plan_plain_text ? `## Plan\n\n${d.plan_plain_text}\n\n` : "") +
        updatesMd +
        linksMd;
      await writeFile(dir, `decisions/${name}.md`, md);
      count++;
    }
  } catch (err: any) {
    log.warn("genDecisions failed:", err?.message);
    await writeFile(dir, "decisions/_ERRORS.md", `# Decisions Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genEpistemic(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const beliefs = await fileBeliefStorage.getAll();
    const beliefsMd =
      `# Beliefs\n\n` +
      beliefs.map((b) => {
        const confLabel = b.confidence >= 0.8 ? "High" : b.confidence >= 0.5 ? "Medium" : "Low";
        const evidenceMd = (b.evidence ?? []).length
          ? "\n**Evidence:**\n" +
            (b.evidence as any[]).map((e: any) =>
              `  - [${e.type ?? "?"}] ${e.summary ?? e.id ?? ""}`
            ).join("\n") + "\n"
          : "";
        return (
          `## [${b.domain ?? "general"}] ${confLabel} confidence\n\n` +
          `${b.claim}\n\n` +
          `- **Confidence:** ${Math.round(b.confidence * 100)}%\n` +
          `- **Status:** ${b.status ?? "active"}\n` +
          (b.principleRef ? `- **Principle:** ${b.principleRef}\n` : "") +
          (b.tags?.length ? `- **Tags:** ${b.tags.join(", ")}\n` : "") +
          evidenceMd
        );
      }).join("\n");
    await writeFile(dir, "epistemic/beliefs.md", beliefsMd);

    // Predictions now live in thesis_predictions table — export from there
    const { thesisStorage } = await import("./thesis-storage");
    const allTheses = await thesisStorage.list();
    const allPredictions: any[] = [];
    for (const t of allTheses) {
      const preds = await thesisStorage.listPredictions(t.id);
      allPredictions.push(...preds.map(p => ({ ...p, thesisTitle: t.title })));
    }
    const predictionsMd =
      `# Predictions\n\n` +
      allPredictions.map((p: any) =>
        `## ${p.claim ?? "Prediction"}\n` +
        `- **Conviction:** ${p.conviction ?? "low"}\n` +
        `- **Thesis:** ${p.thesisTitle ?? ""}\n` +
        `- **Deadline:** ${p.deadline ?? ""}\n` +
        `- **Outcome:** ${p.outcome ?? "pending"}\n`
      ).join("\n");
    await writeFile(dir, "epistemic/predictions.md", predictionsMd);
    count = beliefs.length + allPredictions.length;
  } catch (err: any) {
    log.warn("genEpistemic failed:", err?.message);
    await writeFile(dir, "epistemic/_ERRORS.md", `# Epistemic Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genLife(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    // Principles — stored as identity document "principles"
    try {
      const { documentStorage } = await import("./memory/document-storage");
      const principlesDoc = await documentStorage.getDocument("identity", "principles");
      const principlesContent = principlesDoc?.content ?? "_No principles document found._";
      await writeFile(dir, "life/principles.md", principlesContent);
    } catch (principlesErr: any) {
      log.warn("genLife: could not read principles:", principlesErr?.message);
      await writeFile(dir, "life/principles.md", `# Principles\n\n_Could not read principles document: ${principlesErr?.message}_`);
    }

    // Preferences — document-backed via filePreferenceStorage
    const prefs = await filePreferenceStorage.getAll();
    const prefsByDomain = prefs.reduce((acc: Record<string, typeof prefs>, p) => {
      const d = p.domain ?? "general";
      if (!acc[d]) acc[d] = [];
      acc[d].push(p);
      return acc;
    }, {});
    const prefsMd =
      `# Preferences\n\n` +
      Object.entries(prefsByDomain).map(([domain, items]) =>
        `## ${domain}\n\n` +
        items.map((p) => {
          const evidenceMd = (p.evidence ?? []).length
            ? `\n  Evidence: ${(p.evidence as string[]).map(e => `"${e}"`).join("; ")}`
            : "";
          const tagsMd = p.tags?.length ? ` [tags: ${p.tags.join(", ")}]` : "";
          const personMd = p.personName ? ` (for: ${p.personName})` : "";
          return `- **${p.preference ?? ""}** _(${Math.round((p.confidence ?? 0.5) * 100)}% confident)${personMd}${tagsMd}_${evidenceMd}`;
        }).join("\n")
      ).join("\n\n");
    await writeFile(dir, "life/preferences.md", prefsMd);

    // Rules — document-backed via fileRuleStorage, grouped by scope
    const rules = await fileRuleStorage.getAll();
    const alwaysRules = rules.filter(r => r.scope === "always");
    const contextualRules = rules.filter(r => r.scope !== "always");

    function formatRule(r: any): string {
      return (
        `### Rule\n\n` +
        `${r.rule ?? ""}\n\n` +
        (r.context ? `_Context: ${r.context}_\n\n` : "") +
        `- Confidence: ${Math.round((r.confidence ?? 0.5) * 100)}%` +
        (r.source !== "manual" ? ` | Source: ${r.source}` : "") +
        (r.principleRef ? ` | Principle: ${r.principleRef}` : "") +
        (r.tags?.length ? ` | Tags: ${r.tags.join(", ")}` : "") +
        (r.violations > 0 ? ` | Violations: ${r.violations}` : "") +
        "\n"
      );
    }

    const rulesMd =
      `# Rules\n\n` +
      (alwaysRules.length
        ? `## Always Apply\n\n` + alwaysRules.map(formatRule).join("\n") + "\n"
        : "") +
      (contextualRules.length
        ? `## Contextual\n\n` + contextualRules.map(formatRule).join("\n")
        : "");
    await writeFile(dir, "life/rules.md", rulesMd);

    count = prefs.length + rules.length + 1; // +1 for principles
  } catch (err: any) {
    log.warn("genLife failed:", err?.message);
    await writeFile(dir, "life/_ERRORS.md", `# Life Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genHealth(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const activities = await db.execute(
      sql`SELECT name, benefit, risk, category, interval_days, estimated_minutes, estimated_cost,
               requirements, linked_metric_type, great_threshold, good_threshold, created_at
          FROM wellness_activities WHERE archived_at IS NULL ORDER BY category, name`
    );
    const activitiesMd =
      `# Wellness Activities\n\n` +
      (activities.rows as any[]).map((a: any) =>
        `## ${a.name ?? "Activity"}\n` +
        `- **Category:** ${a.category ?? ""}\n` +
        `- **Interval:** every ${a.interval_days ?? "?"} days\n` +
        (a.estimated_minutes ? `- **Est. Time:** ${a.estimated_minutes} min\n` : "") +
        (a.estimated_cost ? `- **Est. Cost:** ${a.estimated_cost}\n` : "") +
        (a.benefit ? `- **Benefit:** ${a.benefit}\n` : "") +
        (a.risk ? `- **Risk of skipping:** ${a.risk}\n` : "") +
        (a.requirements ? `- **Requirements:** ${a.requirements}\n` : "") +
        (a.linked_metric_type ? `- **Linked Metric:** ${a.linked_metric_type}\n` : "") +
        (a.great_threshold != null ? `- **Great Threshold:** ${a.great_threshold}\n` : "") +
        (a.good_threshold != null ? `- **Good Threshold:** ${a.good_threshold}\n` : "")
      ).join("\n");
    await writeFile(dir, "health/activities.md", activitiesMd);

    const logs = await db.execute(
      sql`SELECT wa.name, wl.completed_at, wl.tier, wl.metric_value, wl.notes
          FROM wellness_logs wl
          JOIN wellness_activities wa ON wa.id = wl.activity_id
          ORDER BY wl.completed_at DESC LIMIT 500`
    );
    const logsMd =
      `# Wellness Logs (last 500)\n\n` +
      (logs.rows as any[]).map((l: any) =>
        `- **${l.name ?? "?"}** — ${l.completed_at?.toISOString?.() ?? l.completed_at ?? "?"} ` +
        `[${l.tier ?? "good"}]` +
        (l.notes ? ` — ${l.notes}` : "")
      ).join("\n");
    await writeFile(dir, "health/logs.md", logsMd);
    count = (activities.rows as any[]).length + (logs.rows as any[]).length;
  } catch (err: any) {
    log.warn("genHealth failed:", err?.message);
    await writeFile(dir, "health/_ERRORS.md", `# Health Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genFinance(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const accounts = await db.execute(
      sql`SELECT name, type, subtype, mask, currency_code, current_balance, available_balance, credit_limit
          FROM plaid_accounts ORDER BY name`
    );
    const accountsMd =
      `# Accounts\n\n` +
      `_Note: balances are point-in-time snapshots. No raw transactions included._\n\n` +
      (accounts.rows as any[]).map((a: any) =>
        `## ${a.name ?? "Account"}\n` +
        `- **Type:** ${a.type ?? ""}${a.subtype ? ` (${a.subtype})` : ""}\n` +
        `- **Mask:** ****${a.mask ?? ""}\n` +
        `- **Current Balance:** ${a.currency_code ?? "USD"} ${a.current_balance ?? "?"}\n` +
        (a.available_balance != null ? `- **Available:** ${a.currency_code ?? "USD"} ${a.available_balance}\n` : "") +
        (a.credit_limit != null ? `- **Credit Limit:** ${a.currency_code ?? "USD"} ${a.credit_limit}\n` : "")
      ).join("\n");
    await writeFile(dir, "finance/accounts.md", accountsMd);

    const goals = await db.execute(
      sql`SELECT name, target_amount, current_amount, target_date, notes, created_at FROM financial_goals ORDER BY target_date`
    );
    const goalsMd =
      `# Financial Goals\n\n` +
      (goals.rows as any[]).map((g: any) =>
        `## ${g.name ?? "Goal"}\n` +
        `- **Target:** $${g.target_amount ?? "?"}\n` +
        `- **Current:** $${g.current_amount ?? "0"}\n` +
        (g.target_date ? `- **By:** ${g.target_date}\n` : "") +
        (g.notes ? `- **Notes:** ${g.notes}\n` : "")
      ).join("\n");
    await writeFile(dir, "finance/goals.md", goalsMd);
    count = (accounts.rows as any[]).length + (goals.rows as any[]).length;
  } catch (err: any) {
    log.warn("genFinance failed:", err?.message);
    await writeFile(dir, "finance/_ERRORS.md", `# Finance Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genContent(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const queue = await db.execute(
      sql`SELECT platform, content, status, scheduled_at, published_at, platform_url, created_at
          FROM content_queue ORDER BY created_at DESC LIMIT 200`
    );
    const md =
      `# Content Queue (last 200)\n\n` +
      (queue.rows as any[]).map((c: any) =>
        `## [${c.status ?? "draft"}] ${c.platform ?? "x"} — ${c.scheduled_at ? new Date(c.scheduled_at).toLocaleDateString() : "unscheduled"}\n\n` +
        `${c.content ?? ""}\n\n` +
        (c.platform_url ? `Published: ${c.platform_url}\n\n` : "") +
        "---\n"
      ).join("\n");
    await writeFile(dir, "content/queue.md", md);
    count = (queue.rows as any[]).length;
  } catch (err: any) {
    log.warn("genContent failed:", err?.message);
    await writeFile(dir, "content/_ERRORS.md", `# Content Export Error\n\n${err?.message ?? err}`);
  }
  return { count };
}

async function genPriorities(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const { goalsService } = await import("./goals-service");
    const horizons = ["today", "this_week", "this_month"] as const;
    const sections: string[] = [];

    for (const horizon of horizons) {
      const goals = await goalsService.listByHorizon(horizon);
      if (goals.length === 0) continue;
      const label = horizon === "today" ? "Daily" : horizon === "this_week" ? "Weekly" : "Monthly";
      sections.push(
        `## ${label}\n\n` +
        goals.map((g: { shortName: string; status: string }) =>
          `- [${g.status === "achieved" ? "x" : " "}] ${g.shortName}`
        ).join("\n"),
      );
      count += goals.length;
    }

    const md = `# Goals & Priorities\n\n${sections.length > 0 ? sections.join("\n\n") : "_No goals recorded_"}`;
    await writeFile(dir, "priorities.md", md);
  } catch (err: any) {
    log.warn("genPriorities failed:", err?.message);
    await writeFile(dir, "priorities.md", `# Priorities\n\n_Export error: ${err?.message}_`);
  }
  return { count };
}

// ---------------------------------------------------------------------------
// Zip helper using JSZip
// ---------------------------------------------------------------------------

async function zipDirectory(sourceDir: string, rootPrefix = ""): Promise<Buffer> {
  // Dynamic import so the module is resolved at runtime in production
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  async function addDir(dirPath: string, zipPath: string): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const zp = zipPath ? `${zipPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await addDir(fullPath, zp);
      } else {
        const content = await fs.readFile(fullPath);
        zip.file(zp, content);
      }
    }
  }

  await addDir(sourceDir, rootPrefix);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function genNotes(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const notes = await db.execute(
      sql`SELECT id, title, plain_text_content, processed_at, created_at FROM info_notes ORDER BY created_at DESC`
    );
    const md =
      `# Scratchpad Notes\n\n` +
      (notes.rows as any[]).map((n: any) =>
        `## ${n.title || "(untitled)"}\n\n` +
        (n.processed_at ? `_Processed: ${n.processed_at}_\n\n` : "") +
        `${n.plain_text_content ?? ""}\n\n---\n`
      ).join("\n");
    await writeFile(dir, "notes.md", md);
    count = (notes.rows as any[]).length;
  } catch (err: any) {
    log.warn("genNotes failed:", err?.message);
    await writeFile(dir, "notes.md", `# Notes\n\n_Export error: ${err?.message}_`);
  }
  return { count };
}

async function genGratitude(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const entries = await db.execute(
      sql`SELECT date, content, created_at FROM gratitude_entries ORDER BY date DESC`
    );
    const md =
      `# Gratitude Journal\n\n` +
      (entries.rows as any[]).map((e: any) =>
        `## ${e.date ?? "?"}\n\n${e.content ?? ""}\n\n---\n`
      ).join("\n");
    await writeFile(dir, "gratitude.md", md);
    count = (entries.rows as any[]).length;
  } catch (err: any) {
    log.warn("genGratitude failed:", err?.message);
    await writeFile(dir, "gratitude.md", `# Gratitude\n\n_Export error: ${err?.message}_`);
  }
  return { count };
}

async function genWellnessMetrics(dir: string): Promise<{ count: number }> {
  let count = 0;
  try {
    const metrics = await db.execute(
      sql`SELECT metric_type, value, unit, date, source FROM health_metrics ORDER BY date DESC, metric_type LIMIT 2000`
    );
    const grouped: Record<string, any[]> = {};
    for (const row of metrics.rows as any[]) {
      const t = (row as any).metric_type ?? "other";
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(row);
    }
    const md =
      `# Health Metrics (last 2000 entries)\n\n` +
      Object.entries(grouped).map(([type, rows]) =>
        `## ${type}\n\n` +
        (rows as any[]).map((r: any) =>
          `- **${r.date ?? "?"}** — ${r.value} ${r.unit ?? ""}` +
          (r.source && r.source !== "apple_health" ? ` (${r.source})` : "")
        ).join("\n")
      ).join("\n\n");
    await writeFile(dir, "wellness-metrics.md", md);
    count = (metrics.rows as any[]).length;
  } catch (err: any) {
    log.warn("genWellnessMetrics failed:", err?.message);
    await writeFile(dir, "wellness-metrics.md", `# Wellness Metrics\n\n_Export error: ${err?.message}_`);
  }
  return { count };
}

const DOMAINS: Array<{
  name: string;
  weight: number;
  fn: (dir: string) => Promise<{ count: number }>;
}> = [
  { name: "library",          weight: 7, fn: genLibrary },
  { name: "notes",            weight: 7, fn: genNotes },
  { name: "people",           weight: 7, fn: genPeople },
  { name: "projects",         weight: 7, fn: genProjects },
  { name: "goals",            weight: 7, fn: genGoals },
  { name: "skills",           weight: 7, fn: genSkills },
  { name: "automation",       weight: 7, fn: genAutomation },

  { name: "decisions",        weight: 7, fn: genDecisions },
  { name: "epistemic",        weight: 7, fn: genEpistemic },
  { name: "life",             weight: 7, fn: genLife },
  { name: "health",           weight: 7, fn: genHealth },
  { name: "wellness-metrics", weight: 7, fn: genWellnessMetrics },
  { name: "gratitude",        weight: 7, fn: genGratitude },
  { name: "finance",          weight: 7, fn: genFinance },
  { name: "content",          weight: 7, fn: genContent },
  { name: "priorities",       weight: 7, fn: genPriorities },
];

export async function runExportOrchestrator(jobId: string): Promise<void> {
  const tempDir = path.join(os.tmpdir(), `xyz-export-${jobId}`);

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await updateExportJob(jobId, { status: "running", progress: 0, currentDomain: "starting" });

    const domainCounts: Record<string, number> = {};
    let done = 0;

    for (const domain of DOMAINS) {
      await updateExportJob(jobId, {
        currentDomain: domain.name,
        progress: Math.round((done / DOMAINS.length) * 100),
      });

      try {
        const result = await domain.fn(tempDir);
        domainCounts[domain.name] = result.count;
        log.log(`export ${jobId}: domain=${domain.name} count=${result.count}`);
      } catch (err: any) {
        log.warn(`export ${jobId}: domain=${domain.name} error: ${err?.message}`);
        domainCounts[domain.name] = 0;
        await writeFile(tempDir, `${domain.name}/_ERRORS.md`,
          `# Export Error — ${domain.name}\n\n${err?.message ?? String(err)}`);
      }
      done++;
    }

    // Write root index
    const exportedAt = new Date().toISOString();
    const totalItems = Object.values(domainCounts).reduce((a, b) => a + b, 0);
    const indexMd =
      `# Mantra Data Export\n\n` +
      `**Exported:** ${exportedAt}\n` +
      `**Total items:** ${totalItems}\n\n` +
      `## Domains\n\n` +
      DOMAINS.map(d =>
        `- **${d.name}** — ${domainCounts[d.name] ?? 0} items`
      ).join("\n") +
      `\n\n---\n_Generated by Mantra. This archive is a complete snapshot of your data._\n`;
    await writeFile(tempDir, "_index.md", indexMd);

    // Zip and upload
    await updateExportJob(jobId, { currentDomain: "compressing", progress: 95 });
    const zipBuffer = await zipDirectory(tempDir, "gstack");

    // Write zip to local tmpdir — no object storage required
    const zipFilePath = path.join(os.tmpdir(), `gstack-${jobId}.zip`);
    await fs.writeFile(zipFilePath, zipBuffer);

    const downloadUrl = `/api/export/archive/${jobId}/download`;

    await updateExportJob(jobId, {
      status: "complete",
      progress: 100,
      currentDomain: null as any,
      downloadUrl,
    });
    log.log(`export ${jobId}: complete size=${(zipBuffer.length / 1024).toFixed(1)}KB`);
  } catch (err: any) {
    log.error(`export ${jobId}: fatal error: ${err?.message}`);
    await updateExportJob(jobId, {
      status: "failed",
      error: err?.message ?? String(err),
      currentDomain: null as any,
    }).catch(() => {});
  } finally {
    // Clean up temp directory
    fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
