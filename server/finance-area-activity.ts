import { getSetting, setSetting } from "./system-settings";

export type FinanceArea = "budget" | "income" | "categories";

function key(area: FinanceArea): string {
  return `finance:area:${area}:lastActivityAt`;
}

export async function bumpFinanceAreaActivity(area: FinanceArea): Promise<void> {
  await setSetting(key(area), new Date().toISOString());
}

export async function getFinanceAreaActivity(area: FinanceArea): Promise<string | null> {
  const v = await getSetting<string>(key(area));
  return typeof v === "string" ? v : null;
}
