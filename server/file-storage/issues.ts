import { documentStorage } from "../memory/document-storage";
import type { Issue, InsertIssue, IssueStatus, IssueNote } from "@shared/schema";
import { createLogger } from "../log";

const log = createLogger("StoreIssues");

function issueToContent(issue: Issue): string {
  let body = "";

  if (issue.description) {
    body += issue.description + "\n";
  }

  if (issue.spec) {
    body += "\n## Spec\n\n" + issue.spec + "\n";
  }

  if (issue.feedback) {
    body += "\n## Feedback\n\n" + issue.feedback + "\n";
  }

  if (issue.logs) {
    body += "\n## Logs\n\n```\n" + issue.logs + "\n```\n";
  }

  const notes: IssueNote[] = Array.isArray(issue.notes) ? issue.notes as IssueNote[] : [];
  if (notes.length > 0) {
    body += "\n## Activity\n";
    for (const note of notes) {
      const ts = note.timestamp || "";
      const author = note.author || "unknown";
      body += `\n### ${ts} [${author}]\n\n${note.content}\n`;
      if (note.statusChange) {
        body += `\n*Status: ${note.statusChange.from} → ${note.statusChange.to}*\n`;
      }
    }
  }

  return body.trim();
}

function parseContent(content: string): {
  description: string;
  spec: string | null;
  feedback: string | null;
  logs: string | null;
  notes: IssueNote[];
} {
  const body = content.trim();

  const specMatch = body.match(/\n## Spec\n\n([\s\S]*?)(?=\n## |\n$|$)/);
  const feedbackMatch = body.match(/\n## Feedback\n\n([\s\S]*?)(?=\n## |\n$|$)/);
  const logsMatch = body.match(/\n## Logs\n\n```\n([\s\S]*?)\n```/);
  const activityMatch = body.match(/\n## Activity\n([\s\S]*?)$/);

  let description = body;
  const firstSection = body.indexOf("\n## ");
  if (firstSection > -1) {
    description = body.substring(0, firstSection);
  }
  description = description.trim();

  let notes: IssueNote[] = [];
  if (activityMatch) {
    const activityBlock = activityMatch[1];
    const noteBlocks = activityBlock.split(/\n### /).filter(Boolean);
    for (const block of noteBlocks) {
      const headerMatch = block.match(/^(.+?)\s+\[(\w+)\]\n\n?([\s\S]*?)(?:\n\n\*Status:\s*(\S+)\s*→\s*(\S+)\*)?$/);
      if (headerMatch) {
        const note: IssueNote = {
          id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: headerMatch[1].trim(),
          author: headerMatch[2] as "user" | "agent",
          content: headerMatch[3].trim(),
        };
        if (headerMatch[4] && headerMatch[5]) {
          note.statusChange = { from: headerMatch[4] as IssueStatus, to: headerMatch[5] as IssueStatus };
        }
        notes.push(note);
      }
    }
  }

  return {
    description,
    spec: specMatch ? specMatch[1].trim() : null,
    feedback: feedbackMatch ? feedbackMatch[1].trim() : null,
    logs: logsMatch ? logsMatch[1].trim() : null,
    notes,
  };
}

function docToIssue(doc: { content: string; metadata: Record<string, unknown> }): Issue {
  const meta = doc.metadata;

  return {
    id: typeof meta.id === "number" ? meta.id : parseInt(String(meta.id), 10),
    title: String(meta.title || "Untitled"),
    description: String(meta.description || ""),
    status: String(meta.status || "open"),
    page: (meta.page as string) || null,
    screenshot: (meta.screenshot as string) || null,
    spec: (meta.spec as string) || null,
    feedback: (meta.feedback as string) || null,
    notes: (meta.notes as IssueNote[]) || null,
    logs: (meta.logs as string) || null,
    dependencies: (meta.dependencies as number[]) || null,
    createdAt: meta.createdAt ? new Date(String(meta.createdAt)) : new Date(),
  };
}

export class FileIssueStorage {
  async getIssues(options?: { status?: string; excludeStatus?: string; lightweight?: boolean }): Promise<Issue[] | Partial<Issue>[]> {
    const filters: Record<string, unknown> = {};
    if (options?.status) {
      filters.status = options.status;
    }

    const docs = await documentStorage.getDocumentsByType("issue", Object.keys(filters).length > 0 ? filters : undefined);
    let allIssues: Issue[] = [];

    for (const doc of docs) {
      try {
        const issue = docToIssue({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
        if (options?.excludeStatus && issue.status === options.excludeStatus) continue;
        allIssues.push(issue);
      } catch (err) {
        log.error(`getIssues parse error docId=${doc.docId}`, err);
      }
    }

    allIssues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    log.log(`getIssues count=${allIssues.length} status=${options?.status || "all"} lightweight=${!!options?.lightweight}`);

    if (options?.lightweight) {
      return allIssues.map(i => ({
        id: i.id,
        title: i.title,
        status: i.status,
        page: i.page,
        createdAt: i.createdAt,
      }));
    }

    return allIssues;
  }

  async getIssue(id: number): Promise<Issue | undefined> {
    const doc = await documentStorage.getDocument("issue", String(id));
    if (!doc) {
      log.log(`getIssue id=${id} not-found`);
      return undefined;
    }
    try {
      log.log(`getIssue id=${id} found`);
      return docToIssue({ content: doc.content, metadata: (doc.metadata || {}) as Record<string, unknown> });
    } catch (err) {
      log.error(`getIssue id=${id} parse error`, err);
      return undefined;
    }
  }

  async createIssue(issue: InsertIssue): Promise<Issue> {
    const id = Date.now() + Math.floor(Math.random() * 1000);

    const now = new Date();
    const full: Issue = {
      id,
      title: issue.title || "Untitled",
      description: issue.description || "",
      status: issue.status || "open",
      page: issue.page || null,
      screenshot: issue.screenshot || null,
      spec: issue.spec || null,
      feedback: issue.feedback || null,
      notes: issue.notes || null,
      logs: issue.logs || null,
      dependencies: issue.dependencies || null,
      createdAt: now,
    };

    const content = issueToContent(full);
    const metadata: Record<string, unknown> = {
      id: full.id,
      title: full.title,
      status: full.status,
      page: full.page,
      screenshot: full.screenshot,
      dependencies: full.dependencies,
      createdAt: full.createdAt.toISOString(),
    };

    await documentStorage.upsertDocument(
      "issue",
      String(id),
      `issues/${id}.md`,
      full.title,
      content,
      metadata
    );

    log.log(`createIssue id=${id} title="${full.title}" status=${full.status}`);
    return full;
  }

  async updateIssue(id: number, updates: Partial<InsertIssue>): Promise<Issue | undefined> {
    const existing = await this.getIssue(id);
    if (!existing) {
      log.log(`updateIssue id=${id} not-found`);
      return undefined;
    }

    const updated: Issue = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt };

    const content = issueToContent(updated);
    const metadata: Record<string, unknown> = {
      id: updated.id,
      title: updated.title,
      status: updated.status,
      page: updated.page,
      screenshot: updated.screenshot,
      dependencies: updated.dependencies,
      createdAt: updated.createdAt instanceof Date ? updated.createdAt.toISOString() : String(updated.createdAt),
    };

    await documentStorage.upsertDocument(
      "issue",
      String(id),
      `issues/${id}.md`,
      updated.title,
      content,
      metadata
    );

    log.log(`updateIssue id=${id} fields=${Object.keys(updates).join(",")}`);
    return updated;
  }

  async deleteIssue(id: number): Promise<boolean> {
    const result = await documentStorage.deleteDocument("issue", String(id));
    log.log(`deleteIssue id=${id} success=${result}`);
    return result;
  }

  async writeIssueWithId(issue: Issue): Promise<void> {
    const content = issueToContent(issue);
    const metadata: Record<string, unknown> = {
      id: issue.id,
      title: issue.title,
      status: issue.status,
      page: issue.page,
      screenshot: issue.screenshot,
      dependencies: issue.dependencies,
      createdAt: issue.createdAt instanceof Date ? issue.createdAt.toISOString() : String(issue.createdAt),
    };

    await documentStorage.upsertDocument(
      "issue",
      String(issue.id),
      `issues/${issue.id}.md`,
      issue.title,
      content,
      metadata
    );
    log.log(`writeIssueWithId id=${issue.id} title="${issue.title}"`);
  }
}

export const fileIssueStorage = new FileIssueStorage();
