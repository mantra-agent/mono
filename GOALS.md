# GOALS.md — Goals Mutation Process

This file is the canonical operating guide for life goals across all horizons: today, this_week, this_month, this_quarter, this_year, three_year, ten_year, and lifetime. Use it whenever a conversation, skill, FTUE flow, or autonomous run may create, edit, complete, rank, link, or discuss goals.

## Core Invariant

A goal represents an intended outcome for a horizon/period. Repeated mentions of the same outcome are evidence, emphasis, clarification, or status updates. They are not new goals.

Before adding any goal:

1. Inspect the current goals for the target horizon.
2. Compare the proposed title against existing goals using exact meaning, not just exact text.
3. If an equivalent goal already exists, update, link, reinforce, or mark that existing goal instead of adding a new one.
4. Ask only when the distinction changes the plan materially. If the user is plainly repeating the same intent, act on the existing goal.

## Goal Horizons

Goals use a unified horizon enum that covers both short-term action items and long-term aspirations:

| Horizon | Meaning | Typical use |
|---|---|---|
| `today` | Daily goals | Morning planning, FTUE |
| `this_week` | Weekly goals | Weekly planning |
| `this_month` | Monthly goals | Monthly planning |
| `this_quarter` | Quarterly goals | Quarterly planning |
| `this_year` | Annual goals | Annual planning |
| `three_year` | 3-year goals | Strategic planning |
| `ten_year` | Decade goals | Vision setting |
| `lifetime` | Lifetime goals | Life mission |

Short horizons (today, this_week, this_month) support period-specific fields: `periodDate`, `periodWeek`, `periodMonth`. These enable querying goals for a specific date/week/month.

## Goal Mutation Rules

- Use `goals.create` only when the horizon does not already contain an equivalent active goal.
- Use `goals.update` when the user provides a clearer name for an existing goal.
- Use `goals.update` with a status change when the user reports progress or completion. Statuses: `active`, `on_track`, `at_risk`, `achieved`, `blocked`, `dormant`.
- Use `goals.set_parent` when a goal should connect to a parent goal in a higher horizon.
- Treat repeated conversational statements as reinforcement unless the user explicitly asks for a separate goal.
- The goals tool enforces deduplication by normalized title within the same horizon. If a duplicate is detected, update the existing goal instead.

## Equivalence Examples

Equivalent, do not add twice:

- `Agent Pitch` and `Jeremie pitch prep`
- `Finish pitch deck` and `finish the pitch deck`
- `Health insurance` and `Close Health Insurance Admin`
- `401k extraction` and `Close 401k Fund Extraction`

Potentially distinct, clarify only if needed:

- `Agent Pitch` and `Build voice demo`, if one is the meeting outcome and the other is a technical subtask.
- `Financial model` and `Fundraising strategy`, if the user is separating artifact creation from strategic decision-making.

## FTUE and Check-In Flows

FTUE, morning planning, evening review, weekly planning, monthly planning, and normal chat all use the same mutation protocol. No flow gets to append goals blindly.

When eliciting goals across multiple turns, keep a working set of proposed goals in the conversation state. If the user restates a goal later, merge it into the working set before writing to the tool.

## Failure Handling

A duplicate rejection is a successful protection of state integrity. Treat it as guidance, not a terminal failure:

- If the new wording is better, call `goals.update` with the existing goal ID and the improved `shortName`.
- If the user reported progress, call `goals.update` with the new status.
- If the duplicate was caused by repeated extraction from a transcript, stop extracting that item and continue with novel goals only.

## Legacy Compatibility

The `priorities` tool remains available as a deprecated compatibility alias. It delegates all operations to the goals system. New code and skills should use the `goals` tool directly.
