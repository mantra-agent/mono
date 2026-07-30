import { and, eq, sql } from "drizzle-orm";
import {
  environmentCapabilityBindings,
  providerConnections,
  upsertSpeechRecognitionBindingSchema,
  type EnvironmentCapabilityBinding,
  type UpsertSpeechRecognitionBinding,
} from "@shared/models/platforms";
import { db } from "../db";
import { getVisibleEnvironment, getWritableEnvironment } from "../platforms/platform-access";
import { listSpeechRecognitionBindings } from "./bindings";

export async function getEnvironmentSpeechRecognitionBindings(environmentId: number) {
  if (!(await getVisibleEnvironment(environmentId))) return null;
  return listSpeechRecognitionBindings(environmentId);
}

async function validatePlatformManagedConnection(input: UpsertSpeechRecognitionBinding) {
  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.id, input.connectionId))
    .limit(1);
  if (!connection) throw new Error("Speech recognition provider connection was not found");
  if (connection.provider !== input.provider) throw new Error("Speech recognition provider does not match its connection");
  if (connection.scope !== "global" && connection.scope !== "system") {
    throw new Error("Speech recognition requires a platform-managed provider connection");
  }
  if (connection.status !== "active") throw new Error("Speech recognition provider connection is inactive");
  if (!connection.credentialEnvelope) throw new Error("Speech recognition provider connection has no credential");
  return connection;
}

export async function upsertEnvironmentSpeechRecognitionBinding(
  environmentId: number,
  raw: unknown,
): Promise<EnvironmentCapabilityBinding> {
  if (!(await getWritableEnvironment(environmentId))) throw new Error("Platform Environment is not writable");
  const input = upsertSpeechRecognitionBindingSchema.parse(raw);
  await validatePlatformManagedConnection(input);
  const [existing] = await db
    .select({ id: environmentCapabilityBindings.id })
    .from(environmentCapabilityBindings)
    .where(and(
      eq(environmentCapabilityBindings.environmentId, environmentId),
      eq(environmentCapabilityBindings.capabilityType, "speech_recognition"),
      eq(environmentCapabilityBindings.provider, input.provider),
    ))
    .limit(1);
  const values = {
    environmentId,
    connectionId: input.connectionId,
    capabilityType: "speech_recognition",
    provider: input.provider,
    config: input.config,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
    secretEnvelope: null,
    secretLast4: "",
    updatedAt: sql`CURRENT_TIMESTAMP`,
  } as const;
  if (existing) {
    const [updated] = await db
      .update(environmentCapabilityBindings)
      .set(values)
      .where(eq(environmentCapabilityBindings.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db.insert(environmentCapabilityBindings).values(values).returning();
  return created;
}

export async function deleteEnvironmentSpeechRecognitionBinding(
  environmentId: number,
  bindingId: number,
): Promise<boolean> {
  if (!(await getWritableEnvironment(environmentId))) throw new Error("Platform Environment is not writable");
  const [deleted] = await db
    .delete(environmentCapabilityBindings)
    .where(and(
      eq(environmentCapabilityBindings.id, bindingId),
      eq(environmentCapabilityBindings.environmentId, environmentId),
      eq(environmentCapabilityBindings.capabilityType, "speech_recognition"),
    ))
    .returning({ id: environmentCapabilityBindings.id });
  return Boolean(deleted);
}
