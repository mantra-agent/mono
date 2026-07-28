import { and, eq, gte, lt, sql } from "drizzle-orm";
import { emailMessages, persons } from "@shared/schema";
import { db } from "./db";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { visibleScopePredicate } from "./scoped-storage";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { userDayBounds } from "./utils/user-time";

const personScope = {
  scope: persons.scope,
  ownerUserId: persons.ownerUserId,
  accountId: persons.accountId,
  vaultId: persons.vaultId,
};

const emailMessageScope = {
  ownerUserId: emailMessages.ownerUserId,
  principalAccountId: emailMessages.principalAccountId,
  vaultId: emailMessages.vaultId,
};

interface InteractionCountRow {
  date: string;
  value: number;
}

interface InteractionEventCountRow {
  date: string;
  value: number;
}

export async function queryNonMeetingInteractionEventSeries(
  startDate: string,
  endDate: string,
  selfEmails: ReadonlySet<string> = new Set(),
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<Map<string, number>> {
  const rangeStart = userDayBounds(startDate).start;
  const rangeEnd = new Date(userDayBounds(endDate).end.getTime() + 1);
  const normalizedSelfEmails = [...selfEmails]
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const recipientEmail = sql`substring(lower(recipient.value) FROM '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}')`;
  const externalRecipientPredicate = normalizedSelfEmails.length > 0
    ? sql`EXISTS (
        SELECT 1
        FROM regexp_split_to_table(
          concat_ws(',', ${emailMessages.toAddresses}, ${emailMessages.ccAddresses}),
          ','
        ) AS recipient(value)
        WHERE ${recipientEmail} IS NOT NULL
          AND ${sql.join(normalizedSelfEmails.map((email) => sql`${recipientEmail} <> ${email}`), sql` AND `)}
      )`
    : sql`concat_ws(',', ${emailMessages.toAddresses}, ${emailMessages.ccAddresses}) ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}'`;

  const result = await db.execute<InteractionEventCountRow>(sql`
    WITH interaction_events AS (
      SELECT
        interaction.value->>'date' AS date,
        COALESCE(
          NULLIF(substring(interaction.value->>'context' FROM '^(email:[^: ]+:[^: ]+:[^: ]+)'), ''),
          concat(${persons.id}, ':', interaction.value->>'id')
        ) AS event_key
      FROM ${persons}
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(${persons.interactions}) = 'array' THEN ${persons.interactions}
          ELSE '[]'::jsonb
        END
      ) AS interaction(value)
      WHERE ${visibleScopePredicate(principal, personScope)}
        AND interaction.value->>'type' IN ('email', 'call', 'text', 'in_person', 'video', 'social')
        AND NOT (
          interaction.value->>'type' = 'email'
          AND interaction.value->>'direction' = 'outbound'
        )
        AND interaction.value->>'date' >= ${startDate}
        AND interaction.value->>'date' <= ${endDate}
      UNION
      SELECT
        to_char(${emailMessages.date} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS date,
        concat('email:', ${emailMessages.provider}, ':', ${emailMessages.accountId}, ':', ${emailMessages.providerMessageId}) AS event_key
      FROM ${emailMessages}
      WHERE ${combineWithSensitiveVisible(emailMessageScope, and(
        eq(emailMessages.direction, "outbound"),
        gte(emailMessages.date, rangeStart),
        lt(emailMessages.date, rangeEnd),
      ), principal)}
        AND ${externalRecipientPredicate}
    )
    SELECT date, COUNT(DISTINCT event_key)::int AS value
    FROM interaction_events
    GROUP BY date
  `);

  return new Map(
    (result.rows ?? []).map((row) => [row.date, Number(row.value)]),
  );
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
