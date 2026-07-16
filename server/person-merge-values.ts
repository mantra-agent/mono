import type {
  Commitment,
  ContactInfo,
  ImportantDate,
  Interaction,
  NetworkConnection,
  Note,
  Person,
} from "./people-storage";

export interface MergedPersonValues {
  person: Person;
  interactionIdMap: Map<string, string>;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${key}:${stableValue(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function unionStrings(target: string[] = [], source: string[] = []): string[] {
  const seen = new Set<string>();
  return [...target, ...source].filter(value => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unionObjects<T>(
  target: T[] = [],
  source: T[] = [],
  keyFor: (value: T) => string = stableValue,
): T[] {
  const seen = new Set<string>();
  return [...target, ...source].filter(value => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeIdentified<T extends { id: string }>(
  target: T[] = [],
  source: T[] = [],
  semanticKey: (value: T) => string,
  sourcePersonId: string,
): { values: T[]; idMap: Map<string, string> } {
  const values = [...target];
  const usedIds = new Set(target.map(value => value.id));
  const byMeaning = new Map(
    target.map((value, index) => [semanticKey(value), { id: value.id, index }]),
  );
  const idMap = new Map<string, string>();

  for (const value of source) {
    const equivalent = byMeaning.get(semanticKey(value));
    if (equivalent) {
      values[equivalent.index] = {
        ...(mergeJson(values[equivalent.index], value) as T),
        id: equivalent.id,
      };
      idMap.set(value.id, equivalent.id);
      continue;
    }
    let nextId = value.id;
    if (usedIds.has(nextId)) nextId = `${value.id}-merged-${sourcePersonId}`;
    const nextValue = nextId === value.id ? value : { ...value, id: nextId };
    values.push(nextValue);
    usedIds.add(nextId);
    byMeaning.set(semanticKey(nextValue), { id: nextId, index: values.length - 1 });
    idMap.set(value.id, nextId);
  }
  return { values, idMap };
}

function mergeJson(target: unknown, source: unknown): unknown {
  if (target === undefined || target === null || target === "") return source;
  if (source === undefined || source === null || source === "") return target;
  if (Array.isArray(target) && Array.isArray(source)) return unionObjects(target, source);
  if (typeof target === "object" && typeof source === "object") {
    const result: Record<string, unknown> = { ...(source as Record<string, unknown>) };
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      result[key] = mergeJson(value, result[key]);
    }
    return result;
  }
  return target;
}

function mergeContactInfo(target: ContactInfo[] = [], source: ContactInfo[] = []): ContactInfo[] {
  return unionObjects(
    target,
    source,
    contact => `${contact.type}|${normalized(contact.value)}`,
  );
}

function mergeConnections(
  target: NetworkConnection[] = [],
  source: NetworkConnection[] = [],
  sourceId: string,
  targetId: string,
): NetworkConnection[] {
  const repoint = (connection: NetworkConnection): NetworkConnection =>
    connection.personId === sourceId ? { ...connection, personId: targetId } : connection;
  return unionObjects(
    target.map(repoint),
    source.map(repoint),
    connection =>
      `${connection.personId || normalized(connection.name)}|${normalized(connection.relationship)}|${normalized(connection.domain)}`,
  );
}

export function repointNetworkProfilePersonId(
  profile: Person["networkProfile"],
  sourceId: string,
  targetId: string,
): Person["networkProfile"] {
  if (!profile?.connections?.some(connection => connection.personId === sourceId)) return profile;
  return {
    ...profile,
    connections: unionObjects(
      profile.connections.map(connection =>
        connection.personId === sourceId ? { ...connection, personId: targetId } : connection,
      ),
      [],
      connection =>
        `${connection.personId || normalized(connection.name)}|${normalized(connection.relationship)}|${normalized(connection.domain)}`,
    ),
  };
}

export function mergePersonValues(target: Person, source: Person): MergedPersonValues {
  const notes = mergeIdentified<Note>(
    target.notes,
    source.notes,
    note => `${normalized(note.title)}|${normalized(note.content)}|${normalized(note.createdAt)}`,
    source.id,
  );
  const interactions = mergeIdentified<Interaction>(
    target.interactions,
    source.interactions,
    interaction =>
      `${normalized(interaction.date)}|${normalized(interaction.type)}|${normalized(interaction.summary)}|${normalized(interaction.context)}|${normalized(interaction.direction)}`,
    source.id,
  );
  const importantDates = mergeIdentified<ImportantDate>(
    target.importantDates,
    source.importantDates,
    date => `${normalized(date.label)}|${normalized(date.date)}|${normalized(date.recurrence)}`,
    source.id,
  );

  const mergedNetwork = mergeJson(target.networkProfile, source.networkProfile) as Person["networkProfile"];
  if (mergedNetwork) {
    mergedNetwork.connections = mergeConnections(
      target.networkProfile?.connections,
      source.networkProfile?.connections,
      source.id,
      target.id,
    );
    mergedNetwork.commitments = mergeIdentified<Commitment>(
      target.networkProfile?.commitments,
      source.networkProfile?.commitments,
      commitment =>
        `${normalized(commitment.direction)}|${normalized(commitment.description)}|${normalized(commitment.status)}|${normalized(commitment.createdAt)}`,
      source.id,
    ).values;
  }

  const nicknames = unionStrings(
    target.nicknames,
    source.name !== target.name ? [...source.nicknames, source.name] : source.nicknames,
  ).filter(name => normalized(name) !== normalized(target.name));

  const latestViewed = [target.lastViewedAt, source.lastViewedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return {
    person: {
      ...source,
      ...target,
      id: target.id,
      name: target.name,
      nicknames,
      cabinetLevel: target.cabinetLevel || source.cabinetLevel,
      photo: target.photo || source.photo,
      birthday: target.birthday || source.birthday,
      company: target.company || source.company,
      companyId: target.companyId || source.companyId,
      role: target.role || source.role,
      professionalRelations: unionStrings(target.professionalRelations, source.professionalRelations),
      relation: target.relation || source.relation,
      introducedBy: target.introducedBy || source.introducedBy,
      familiarity: target.familiarity || source.familiarity,
      trust: target.trust || source.trust,
      met: target.met || source.met,
      socialProfiles: mergeJson(target.socialProfiles, source.socialProfiles) as Person["socialProfiles"],
      contactInfo: mergeContactInfo(target.contactInfo, source.contactInfo),
      importantDates: importantDates.values,
      notes: notes.values,
      interactions: interactions.values,
      tags: unionStrings(target.tags, source.tags),
      aiSummary: target.aiSummary || source.aiSummary,
      quickSummary: target.quickSummary || source.quickSummary,
      identityContent: target.identityContent || source.identityContent,
      relationshipProfile: mergeJson(
        target.relationshipProfile,
        source.relationshipProfile,
      ) as Person["relationshipProfile"],
      networkProfile: mergedNetwork,
      dailyContact: Boolean(target.dailyContact || source.dailyContact),
      private: Boolean(target.private || source.private),
      lastViewedAt: latestViewed,
      createdAt: target.createdAt,
      updatedAt: new Date().toISOString(),
    },
    interactionIdMap: interactions.idMap,
  };
}
