import type { CalendarEventArtifact, CalendarEventPerson } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { and, inArray } from "drizzle-orm";
import { db } from "./db";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { peopleStorage, type Interaction, type Person } from "./people-storage";
import { visibleScopePredicate } from "./scoped-storage";

export interface MeetingPersonContext {
  id: string;
  name: string;
  profileSummary: string | null;
  lastInteractionContext: string | null;
}

export interface EmailPersonContext {
  id: string;
  name: string;
  summary: string | null;
  lastInteractionContext: string | null;
}

export interface MeetingArtifactContext {
  id: number;
  metadataId: number;
  libraryPageId: string;
  title: string;
  slug: string;
  artifactKind: string;
  source: string | null;
  summary: string | null;
  oneLiner: string | null;
}

function latestInteraction(interactions: Interaction[]): Interaction | null {
  return interactions
    .filter(interaction => interaction.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] ?? null;
}

export function meetingPersonSummary(person: Person): string | null {
  return person.aiSummary?.trim() || person.quickSummary?.trim() || person.identityContent?.trim() || null;
}

export function meetingInteractionContext(interactions: Interaction[]): string | null {
  const interaction = latestInteraction(interactions);
  if (!interaction) return null;
  const summary = interaction.summary?.trim() || "No summary recorded";
  const date = interaction.date ? interaction.date.slice(0, 10) : "date missing";
  return `${date} ${interaction.type}: ${summary}`;
}

export async function buildEmailPersonContextMap(): Promise<Map<string, EmailPersonContext>> {
  const entries = await peopleStorage.listPeople();
  const people = await peopleStorage.getPeopleByIds(entries.map(entry => entry.id));
  const emailMap = new Map<string, EmailPersonContext>();

  for (const person of people) {
    for (const contact of person.contactInfo ?? []) {
      if (contact.type !== "email" || !contact.value) continue;
      emailMap.set(contact.value.toLowerCase(), {
        id: person.id,
        name: person.name,
        summary: meetingPersonSummary(person),
        lastInteractionContext: meetingInteractionContext(person.interactions ?? []),
      });
    }
  }

  return emailMap;
}

export async function resolveMeetingPeopleContext(links: CalendarEventPerson[]): Promise<MeetingPersonContext[]> {
  if (links.length === 0) return [];
  const people = await peopleStorage.getPeopleByIds(links.map(link => link.personId));
  const peopleById = new Map(people.map(person => [person.id, person]));

  return links.map(link => {
    const person = peopleById.get(link.personId);
    return {
      id: link.personId,
      name: person?.name?.trim() || link.personName,
      profileSummary: person ? meetingPersonSummary(person) : null,
      lastInteractionContext: person ? meetingInteractionContext(person.interactions ?? []) : null,
    };
  });
}

export async function resolveMeetingArtifactContext(links: CalendarEventArtifact[]): Promise<MeetingArtifactContext[]> {
  if (links.length === 0) return [];
  const pageIds = Array.from(new Set(links.map(link => link.libraryPageId)));
  const principal = getCurrentPrincipalOrSystem();
  const pages = await db
    .select({
      id: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      oneLiner: libraryPages.oneLiner,
      summary: libraryPages.summary,
      plainTextContent: libraryPages.plainTextContent,
    })
    .from(libraryPages)
    .where(and(
      inArray(libraryPages.id, pageIds),
      visibleScopePredicate(principal, {
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
        accountId: libraryPages.accountId,
      }),
    ));
  const pagesById = new Map(pages.map(page => [page.id, page]));

  return links.flatMap(link => {
    const page = pagesById.get(link.libraryPageId);
    if (!page) return [];
    return [{
      id: link.id,
      metadataId: link.metadataId,
      libraryPageId: page.id,
      title: link.title?.trim() || page.title?.trim() || "Meeting artifact",
      slug: page.slug,
      artifactKind: link.artifactKind,
      source: link.source,
      summary: page.summary?.trim() || page.plainTextContent?.trim() || null,
      oneLiner: page.oneLiner?.trim() || null,
    }];
  });
}
