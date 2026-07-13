import { and, count, gte, lt } from "drizzle-orm";
import { opportunityInteractions, wellnessLogs } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { peopleStorage } from "./people-storage";
import { combineWithVisibleScope } from "./scoped-storage";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { userDayBounds } from "./utils/user-time";

const opportunityInteractionScope = {
  scope: opportunityInteractions.scope,
  ownerUserId: opportunityInteractions.ownerUserId,
  accountId: opportunityInteractions.accountId,
};

const wellnessLogScope = {
  ownerUserId: wellnessLogs.ownerUserId,
  principalAccountId: wellnessLogs.principalAccountId,
};

export interface ActivityDashboardKpi {
  key: "opportunity_interactions" | "wellness_completions";
  label: string;
  value: number;
}

export interface ActivityDashboardResult {
  date: string;
  kpis: ActivityDashboardKpi[];
}

interface KpiDefinition {
  key: ActivityDashboardKpi["key"];
  label: string;
  count: (date: string, principal: Principal) => Promise<number>;
}

async function countOpportunityInteractions(date: string, principal: Principal): Promise<number> {
  const links = await db
    .select({ personId: opportunityInteractions.personId, interactionId: opportunityInteractions.interactionId })
    .from(opportunityInteractions)
    .where(combineWithVisibleScope(principal, opportunityInteractionScope));

  const distinctLinks = new Map<string, { personId: string; interactionId: string }>();
  for (const link of links) distinctLinks.set(`${link.personId}:${link.interactionId}`, link);

  const people = await peopleStorage.getPeopleByIds([...new Set(links.map((link) => link.personId))]);
  const interactionDates = new Map(
    people.flatMap((person) => person.interactions.map((interaction) => [
      `${person.id}:${interaction.id}`,
      interaction.date,
    ] as const)),
  );

  let total = 0;
  for (const key of distinctLinks.keys()) {
    if (interactionDates.get(key) === date) total += 1;
  }
  return total;
}

async function countWellnessCompletions(date: string, principal: Principal): Promise<number> {
  const { start, end } = userDayBounds(date);
  const exclusiveEnd = new Date(end.getTime() + 1);
  const [row] = await db
    .select({ value: count() })
    .from(wellnessLogs)
    .where(combineWithSensitiveVisible(
      wellnessLogScope,
      and(gte(wellnessLogs.completedAt, start), lt(wellnessLogs.completedAt, exclusiveEnd)),
      principal,
    ));
  return Number(row?.value ?? 0);
}

const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  {
    key: "opportunity_interactions",
    label: "Opportunity interactions",
    count: countOpportunityInteractions,
  },
  {
    key: "wellness_completions",
    label: "Wellness completions",
    count: countWellnessCompletions,
  },
];

export async function queryActivityDashboard(date: string, principal: Principal): Promise<ActivityDashboardResult> {
  const values = await Promise.all(KPI_DEFINITIONS.map((definition) => definition.count(date, principal)));
  return {
    date,
    kpis: KPI_DEFINITIONS.map((definition, index) => ({
      key: definition.key,
      label: definition.label,
      value: values[index],
    })),
  };
}
