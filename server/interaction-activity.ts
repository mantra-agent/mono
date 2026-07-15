import { peopleStorage } from "./people-storage";

const QUALIFYING_INTERACTION_TYPES = new Set(["email", "call", "text"]);

function increment(counts: Map<string, number>, date: string): void {
  counts.set(date, (counts.get(date) ?? 0) + 1);
}

export async function queryQualifyingInteractionSeries(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const index = await peopleStorage.listPeople();
  const people = await peopleStorage.getPeopleByIds(index.map((person) => person.id));
  const counts = new Map<string, number>();

  for (const person of people) {
    for (const interaction of person.interactions) {
      if (!QUALIFYING_INTERACTION_TYPES.has(interaction.type)) continue;
      if (interaction.date < startDate || interaction.date > endDate) continue;
      increment(counts, interaction.date);
    }
  }

  return counts;
}
