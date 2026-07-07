import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatMessage } from "@/components/chat-shared";
import type { LibraryPage } from "@/pages/library/types";

/** @deprecated Notes were migrated to Library pages. This type is kept only for historical chip resolution. */
interface InfoNote { id: string; noteId: number; title: string; }

export type LinkedEntityKind = "library" | "person" | "goal" | "note";

export interface LinkedEntity {
  kind: LinkedEntityKind;
  id: string;
  title: string;
  emoji: string | null;
  slug?: string;
}

interface PersonIndex {
  id: string;
  name: string;
  nicknames?: string[];
}

interface GoalIndex {
  id: string;
  shortName: string;
}

const WIKI_LINK_RE = /\[\[([^\]\n]+?)\]\]/g;
const LIBRARY_URL_PATH_RE = /\/info\/library\/([A-Za-z0-9_-]+)/g;
const LIBRARY_URL_QUERY_RE = /\/info(?:\/library|#library)\?page=([A-Za-z0-9_-]+)/g;
const LIBRARY_BADGE_RE = /\[(?:spec|page):([a-z0-9-]+)\]/gi;
const PERSON_URL_RE = /\/people\/([A-Za-z0-9_-]+)/g;
const PERSON_BADGE_RE = /\[(?:person|people):\s*([A-Za-z0-9_-]+)\]/gi;
const GOAL_URL_RE = /\/goals\/([A-Za-z0-9_-]+)/g;
const GOAL_BADGE_RE = /\[goal:\s*([A-Za-z0-9_-]+)\]/gi;
const NOTE_URL_RE = /\/info(?:\/notes\/|#notes\?id=)([A-Za-z0-9_-]+)/g;
const NOTE_BADGE_RE = /\[note:\s*([A-Za-z0-9_-]+)\]/gi;

type Ref =
  | { kind: "wiki"; value: string }
  | { kind: "library-id"; value: string }
  | { kind: "person-id"; value: string }
  | { kind: "goal-id"; value: string }
  | { kind: "note-id"; value: string };

function collectRefs(content: string): Ref[] {
  const collected: Array<{ index: number; ref: Ref }> = [];
  const push = (re: RegExp, build: (m: string) => Ref | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const ref = build(m[1].trim());
      if (ref) collected.push({ index: m.index, ref });
    }
  };
  push(WIKI_LINK_RE, (v) => (v ? { kind: "wiki", value: v } : null));
  push(LIBRARY_URL_PATH_RE, (v) => (v ? { kind: "library-id", value: v } : null));
  push(LIBRARY_URL_QUERY_RE, (v) => (v ? { kind: "library-id", value: v } : null));
  push(LIBRARY_BADGE_RE, (v) => (v ? { kind: "library-id", value: v } : null));
  push(PERSON_URL_RE, (v) => (v ? { kind: "person-id", value: v } : null));
  push(PERSON_BADGE_RE, (v) => (v ? { kind: "person-id", value: v } : null));
  push(GOAL_URL_RE, (v) => (v ? { kind: "goal-id", value: v } : null));
  push(GOAL_BADGE_RE, (v) => (v ? { kind: "goal-id", value: v } : null));
  push(NOTE_URL_RE, (v) => (v ? { kind: "note-id", value: v } : null));
  push(NOTE_BADGE_RE, (v) => (v ? { kind: "note-id", value: v } : null));
  collected.sort((a, b) => a.index - b.index);
  return collected.map((c) => c.ref);
}

export function useLinkedEntities(messages: ChatMessage[] | undefined): LinkedEntity[] {
  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
    staleTime: 30_000,
  });
  const { data: peopleResp } = useQuery<{ people: PersonIndex[] }>({
    queryKey: ["/api/people"],
    staleTime: 30_000,
  });
  const { data: goalsResp } = useQuery<{ goals: GoalIndex[] }>({
    queryKey: ["/api/life-goals"],
    staleTime: 30_000,
  });
  const { data: notes = [] } = useQuery<InfoNote[]>({
    queryKey: ["/api/info/notes"],
    staleTime: 30_000,
  });

  return useMemo(() => {
    if (!messages || messages.length === 0) return [];
    const people = peopleResp?.people ?? [];
    const goals = goalsResp?.goals ?? [];

    const pageById = new Map<string, LibraryPage>();
    const pageBySlug = new Map<string, LibraryPage>();
    const pageByTitle = new Map<string, LibraryPage>();
    for (const p of pages) {
      pageById.set(p.id, p);
      if (p.slug) pageBySlug.set(p.slug.toLowerCase(), p);
      if (p.title) pageByTitle.set(p.title.toLowerCase(), p);
    }
    const personById = new Map<string, PersonIndex>();
    const personByName = new Map<string, PersonIndex>();
    for (const person of people) {
      personById.set(person.id, person);
      if (person.name) personByName.set(person.name.toLowerCase(), person);
      for (const nick of person.nicknames ?? []) {
        if (nick) personByName.set(nick.toLowerCase(), person);
      }
    }
    const goalById = new Map<string, GoalIndex>();
    const goalByName = new Map<string, GoalIndex>();
    for (const g of goals) {
      goalById.set(g.id, g);
      if (g.shortName) goalByName.set(g.shortName.toLowerCase(), g);
    }
    const noteById = new Map<string, InfoNote>();
    const noteByTitle = new Map<string, InfoNote>();
    for (const n of notes) {
      noteById.set(n.id, n);
      if (n.title) noteByTitle.set(n.title.toLowerCase(), n);
    }

    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    const seen = new Set<string>();
    const out: LinkedEntity[] = [];

    const addLibrary = (p: LibraryPage) => {
      const key = `library:${p.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: "library", id: p.id, title: p.title, slug: p.slug, emoji: p.emoji });
    };
    const addPerson = (person: PersonIndex) => {
      const key = `person:${person.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: "person", id: person.id, title: person.name, emoji: null });
    };
    const addGoal = (g: GoalIndex) => {
      const key = `goal:${g.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: "goal", id: g.id, title: g.shortName, emoji: null });
    };
    const addNote = (n: InfoNote) => {
      const key = `note:${n.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: "note", id: n.id, title: n.title || "Untitled note", emoji: null });
    };

    for (const msg of sorted) {
      if (!msg.content) continue;
      const refs = collectRefs(msg.content);
      for (const ref of refs) {
        switch (ref.kind) {
          case "library-id": {
            const page = pageById.get(ref.value) || pageBySlug.get(ref.value.toLowerCase());
            if (page) addLibrary(page);
            break;
          }
          case "person-id": {
            const person = personById.get(ref.value);
            if (person) addPerson(person);
            break;
          }
          case "goal-id": {
            const goal = goalById.get(ref.value);
            if (goal) addGoal(goal);
            break;
          }
          case "note-id": {
            const note = noteById.get(ref.value);
            if (note) addNote(note);
            break;
          }
          case "wiki": {
            const lower = ref.value.toLowerCase();
            const page = pageByTitle.get(lower);
            if (page) {
              addLibrary(page);
              break;
            }
            const person = personByName.get(lower);
            if (person) {
              addPerson(person);
              break;
            }
            const goal = goalByName.get(lower);
            if (goal) {
              addGoal(goal);
              break;
            }
            const note = noteByTitle.get(lower);
            if (note) {
              addNote(note);
              break;
            }
            break;
          }
        }
      }
    }

    return out;
  }, [messages, pages, peopleResp, goalsResp, notes]);
}
