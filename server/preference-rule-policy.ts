export const PREFERENCE_RULE_PERSISTENCE_CONTEXT = [
  "**Preference and rule persistence:**",
  "- Preferences and rules are user-specific learned state. Universal product behavior, tool policy, and system invariants belong in global context/code, never in a user's preference or rule record.",
  "- Before any Agent-originated save, create, update, or reinforcement of a preference or rule, present the exact proposed record through the `question` tool and wait for explicit confirmation in the Question widget.",
  "- Confirmation cannot be inferred from conversation, including a direct request to save. If confirmation is declined or absent, do not mutate preference or rule state.",
  "- Check for an existing match before asking. Creating, updating, and reinforcing are distinct mutations, and each requires confirmation of the exact proposed outcome.",
].join("\n");

export const QUESTION_TOOL_DESCRIPTION =
  "Ask the user one bounded question as an inline Session Window widget, then stop and wait for their response. Use for clarification or whenever system policy requires explicit confirmation, even if the answer seems inferable from conversation. This is not a durable Decision record.";

export const PREFERENCES_TOOL_DESCRIPTION =
  "Manage learned user preferences — likes, dislikes, working styles, personal facts. Agent-originated save/create/update/reinforce actions require prior explicit confirmation through the Question widget. Never store universal product behavior, tool policy, or system invariants as a personal preference. Actions: list, get, save, create, update, delete, reinforce.";

export const RULES_TOOL_DESCRIPTION =
  "Manage user-specific behavioral rules and operational directives. Agent-originated save/create/update/reinforce actions require prior explicit confirmation through the Question widget. Never store universal product behavior, tool policy, or system invariants as a personal rule. Actions: list, get, save, create, update, delete, reinforce, violation.";
