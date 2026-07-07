-- One-time cleanup for skill rows that were retired into DB-backed prompt_modules.
-- Runtime prompt resolution is prompt_modules-authoritative; these rows must not
-- be maintained by the skill bootstrap path.
DELETE FROM skills
WHERE name IN (
  'triage',
  'email-triage',
  'review-daily',
  'detect-misalignment',
  'spec',
  'spec-write',
  'opportunity-research',
  'investigate',
  'note-process',
  'reflect-weekly',
  'principles-generate',
  'tools-summarizecontent',
  'tools-summarizewebcontent',
  'tools-mergewebcontentsummaries',
  'myelination-concept-crossref',
  'myelination-concept-extract',
  'agent-classifycomplexity',
  'chat-compactrunhistory',
  'myelination-cross-concept',
  'myelination-link',
  'myelination-mid-merge',
  'myelination-mid-merge-consolidate',
  'myelination-summarize',
  'people-deepsummary',
  'people-quicksummary',
  'strategy-discovermoves',
  'strategy-evaluatemove',
  'strategy-evaluatestate',
  'tools-indexcontent'
);
