import { useQuery } from "@tanstack/react-query";

export interface ExpenseCategory {
  id: number;
  name: string;
  isDefault: boolean;
  plaidCategory: string | null;
  color: string | null;
}

const FALLBACK_LABELS: Record<string, string> = {
  FOOD_AND_DRINK: "Food & Drink",
  TRANSPORTATION: "Transportation",
  RENT_AND_UTILITIES: "Rent & Utilities",
  GENERAL_MERCHANDISE: "Shopping",
  ENTERTAINMENT: "Entertainment",
  PERSONAL_CARE: "Personal Care",
  GENERAL_SERVICES: "Services",
  HOME_IMPROVEMENT: "Home",
  TRAVEL: "Travel",
  MEDICAL: "Medical",
  UNCATEGORIZED: "Other",
};

export const categoryLabels: Record<string, string> = FALLBACK_LABELS;

export function useCategoryLabels() {
  const query = useQuery<{ categories: ExpenseCategory[] }>({ queryKey: ["/api/finance/categories"] });
  const categories = query.data?.categories || [];

  const labels: Record<string, string> = { ...FALLBACK_LABELS };
  const colors: Record<string, string> = {};

  for (const cat of categories) {
    if (cat.plaidCategory) {
      labels[cat.plaidCategory] = cat.name;
    }
    labels[cat.name] = cat.name;
    if (cat.color) {
      if (cat.plaidCategory) colors[cat.plaidCategory] = cat.color;
      colors[cat.name] = cat.color;
    }
  }

  return { labels, colors, categories, isLoading: query.isLoading };
}

export function humanCategory(cat: string): string {
  return FALLBACK_LABELS[cat] || cat.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}
