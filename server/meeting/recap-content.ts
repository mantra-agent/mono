const AGENDA_HEADING = /^##\s+Agenda\s*$/im;
const SUMMARY_HEADING = /^##\s+Summary\s*$/im;

/**
 * Private meeting preparation must never survive in canonical recap content.
 * Legacy generated recaps placed it between the metadata preamble and Summary;
 * remove that complete range rather than trusting downstream section pickers.
 */
export function stripPrivateAgendaFromRecap(markdown: string): string {
  const agendaMatch = AGENDA_HEADING.exec(markdown);
  if (!agendaMatch) return markdown;

  const afterAgenda = markdown.slice(agendaMatch.index + agendaMatch[0].length);
  const summaryMatch = SUMMARY_HEADING.exec(afterAgenda);
  if (!summaryMatch) return markdown;
  const suffix = afterAgenda.slice(summaryMatch.index);

  return `${markdown.slice(0, agendaMatch.index).trimEnd()}\n\n${suffix.trimStart()}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
