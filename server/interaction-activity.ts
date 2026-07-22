import { sql } from "drizzle-orm";
import { persons } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { visibleScopePredicate } from "./scoped-storage";

const personScope = {
  scope: persons.scope,
  ownerUserId: persons.ownerUserId,
  accountId: persons.accountId,
  vaultId: persons.vaultId,
};

interface InteractionCountRow {
  date: string;
  value: number;
}

export async function queryDistinctInteractionPeopleSeries(
  startDate: string,
  endDate: string,
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<Map<string, number>> {
  const result = await db.execute<InteractionCountRow>(sql`
    SELECT
      interaction.value->>'date' AS date,
      COUNT(DISTINCT ${persons.id})::int AS value
    FROM ${persons}
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(${persons.interactions}) = 'array' THEN ${persons.interactions}
        ELSE '[]'::jsonb
      END
    ) AS interaction(value)
    WHERE ${visibleScopePredicate(principal, personScope)}
      AND interaction.value->>'type' IN ('email', 'call', 'text', 'in_person', 'video', 'social')
      AND interaction.value->>'date' >= ${startDate}
      AND interaction.value->>'date' <= ${endDate}
    GROUP BY interaction.value->>'date'
  `);

  return new Map(
    (result.rows ?? []).map((row) => [row.date, Number(row.value)]),
  );
}
