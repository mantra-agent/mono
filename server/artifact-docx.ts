import { randomUUID } from "crypto";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import { coverLetterContentSchema, resumeContentSchema, type CoverLetterContent, type ResumeContent } from "@shared/schema";
import { BRAND } from "./docx-brand";
import { storageBackend } from "./object_storage/s3-backend";
import { setObjectAclPolicy } from "./object_storage/objectAcl";
import { vaultObjectKeyAuto } from "./object_storage/vault-keys";
import { createLogger } from "./log";

const log = createLogger("ArtifactDocx");

function p(text = "", opts: { bold?: boolean; size?: number; color?: string; heading?: boolean } = {}): Paragraph {
  return new Paragraph({
    heading: opts.heading ? HeadingLevel.HEADING_2 : undefined,
    spacing: { after: opts.heading ? 120 : 80 },
    children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? BRAND.sizes.body, color: opts.color ?? BRAND.colors.foreground })],
  });
}

function resumeDoc(data: ResumeContent): Document {
  return new Document({ sections: [{ properties: {}, children: [
    new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 40 }, children: [new TextRun({ text: data.name, bold: true, size: BRAND.sizes.name, color: BRAND.colors.accent })] }),
    new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 160 }, children: [new TextRun({ text: [data.contact.email, data.contact.phone, data.contact.linkedin, data.contact.location].filter(Boolean).join(" | "), size: BRAND.sizes.small, color: BRAND.colors.muted })] }),
    p(data.targetTitle, { bold: true, size: 24 }),
    p(data.summary),
    p("Core Competencies", { heading: true, color: BRAND.colors.accent }),
    p(data.competencies.join(" | ")),
    ...(data.achievements?.length ? [p("Selected Achievements", { heading: true, color: BRAND.colors.accent }), ...data.achievements.map(x => p(`• ${x}`))] : []),
    p("Experience", { heading: true, color: BRAND.colors.accent }),
    ...data.roles.flatMap(role => [
      p(`${role.company} — ${role.title} | ${role.dates}`, { bold: true }),
      ...(role.contextLine ? [p(role.contextLine, { color: BRAND.colors.muted })] : []),
      ...role.bullets.map(b => p(`• ${b}`)),
    ]),
    ...(data.education?.length ? [p("Education", { heading: true, color: BRAND.colors.accent }), ...data.education.map(e => p([e.institution, e.degree, e.field, e.year].filter(Boolean).join(" | ")))] : []),
  ] }] });
}

function coverLetterDoc(data: CoverLetterContent): Document {
  return new Document({ sections: [{ properties: {}, children: [
    new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 40 }, children: [new TextRun({ text: data.name, bold: true, size: BRAND.sizes.name, color: BRAND.colors.accent })] }),
    new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 240 }, children: [new TextRun({ text: [data.contact.email, data.contact.phone, data.contact.linkedin].filter(Boolean).join(" | "), size: BRAND.sizes.small, color: BRAND.colors.muted })] }),
    p(data.date),
    ...(data.recipient ? [p(data.recipient)] : []),
    p(data.company),
    p(data.roleTitle),
    p(data.salutation),
    ...data.paragraphs.map(x => p(x)),
    p(data.closing),
    p(data.name),
  ] }] });
}

export async function renderArtifactDocx(kind: "resume" | "cover_letter", content: unknown, fileName?: string): Promise<string> {
  const doc = kind === "resume"
    ? resumeDoc(resumeContentSchema.parse(content))
    : coverLetterDoc(coverLetterContentSchema.parse(content));

  const buffer = await Packer.toBuffer(doc);
  const objectId = randomUUID();
  const key = vaultObjectKeyAuto("uploads", `${objectId}.docx`);

  await storageBackend.putObject(key, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  await setObjectAclPolicy(key, { owner: "system", visibility: "public" });

  const objectPath = `/objects/uploads/${objectId}.docx`;
  log.log(`[Render] ${kind} -> ${objectPath} (${buffer.length} bytes)`);
  return objectPath;
}
