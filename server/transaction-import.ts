import { db } from "./db";
import { plaidTransactions, plaidAccounts, merchantCategoryOverrides, expenseCategories } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

interface ParsedRow {
  date: string;
  description: string;
  amount: number;
}

interface ColumnMapping {
  date: number;
  description: number;
  amount: number;
  debit?: number;
  credit?: number;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export function parseCSV(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCSVLine(l));
  return { headers, rows };
}

function normalizeDate(raw: string): string | null {
  const cleaned = raw.trim();
  const mdySlash = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdySlash) {
    const month = mdySlash[1].padStart(2, "0");
    const day = mdySlash[2].padStart(2, "0");
    let year = mdySlash[3];
    if (year.length === 2) year = (parseInt(year) > 50 ? "19" : "20") + year;
    return `${year}-${month}-${day}`;
  }
  const ymd = cleaned.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  }
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "").replace(/\((.+)\)/, "-$1");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractMerchant(description: string): string {
  let name = description
    .replace(/\b(PURCHASE|POS|DEBIT|CREDIT|PAYMENT|WITHDRAWAL|DEPOSIT|TRANSFER|ACH|CHECK|ATM)\b/gi, "")
    .replace(/\b\d{2,4}[\/\-]\d{2}[\/\-]\d{2,4}\b/g, "")
    .replace(/\b(VISA|MASTERCARD|MC|AMEX|CHECKCARD)\b/gi, "")
    .replace(/\b[A-Z]{2}\s+\d{5}\b/g, "")
    .replace(/#\d+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (name.length > 50) name = name.substring(0, 50).trim();
  return name || description.trim();
}

const KEYWORD_CATEGORIES: Record<string, { primary: string; detailed: string }> = {
  "walmart": { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_SUPERSTORES" },
  "target": { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_SUPERSTORES" },
  "costco": { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_SUPERSTORES" },
  "amazon": { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES" },
  "kroger": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "safeway": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "whole foods": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "trader joe": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "aldi": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "publix": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  "mcdonald": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "starbucks": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
  "dunkin": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
  "chipotle": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "subway": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "chick-fil-a": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "taco bell": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "wendy": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "doordash": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "uber eats": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "grubhub": { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_RESTAURANT" },
  "shell": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" },
  "exxon": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" },
  "chevron": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" },
  "bp ": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_GAS" },
  "uber": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES" },
  "lyft": { primary: "TRANSPORTATION", detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES" },
  "netflix": { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_TV_AND_MOVIES" },
  "spotify": { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_MUSIC_AND_AUDIO" },
  "hulu": { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_TV_AND_MOVIES" },
  "disney+": { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_TV_AND_MOVIES" },
  "apple music": { primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_MUSIC_AND_AUDIO" },
  "cvs": { primary: "MEDICAL", detailed: "MEDICAL_PHARMACIES_AND_SUPPLEMENTS" },
  "walgreens": { primary: "MEDICAL", detailed: "MEDICAL_PHARMACIES_AND_SUPPLEMENTS" },
  "home depot": { primary: "HOME_IMPROVEMENT", detailed: "HOME_IMPROVEMENT_HARDWARE" },
  "lowe": { primary: "HOME_IMPROVEMENT", detailed: "HOME_IMPROVEMENT_HARDWARE" },
  "electric": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_ELECTRIC" },
  "water": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_WATER" },
  "gas bill": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_GAS" },
  "internet": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_INTERNET_AND_CABLE" },
  "comcast": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_INTERNET_AND_CABLE" },
  "at&t": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_TELEPHONE" },
  "verizon": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_TELEPHONE" },
  "t-mobile": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_TELEPHONE" },
  "rent": { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" },
  "mortgage": { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" },
  "insurance": { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INSURANCE_PREMIUMS" },
  "gym": { primary: "PERSONAL_CARE", detailed: "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS" },
  "planet fitness": { primary: "PERSONAL_CARE", detailed: "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS" },
};

async function buildCategoryMap(): Promise<Map<string, { primary: string; detailed: string | null }>> {
  const existing = await db.select({
    merchantName: plaidTransactions.merchantName,
    name: plaidTransactions.name,
    categoryPrimary: plaidTransactions.categoryPrimary,
    categoryDetailed: plaidTransactions.categoryDetailed,
  }).from(plaidTransactions)
    .where(sql`${plaidTransactions.categoryPrimary} IS NOT NULL`);

  const map = new Map<string, { primary: string; detailed: string | null }>();
  for (const txn of existing) {
    const key = (txn.merchantName || txn.name || "").toLowerCase().trim();
    if (key && txn.categoryPrimary && !map.has(key)) {
      map.set(key, { primary: txn.categoryPrimary, detailed: txn.categoryDetailed });
    }
  }
  return map;
}

function fuzzyMatch(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(n) || n.includes(h)) return true;
  const words = n.split(/\s+/).filter(w => w.length > 3);
  return words.length > 0 && words.some(w => h.includes(w));
}

function matchCategory(
  merchant: string,
  categoryMap: Map<string, { primary: string; detailed: string | null }>,
  overrideMap: Map<string, { primary: string | null; detailed: string | null }>
): { primary: string; detailed: string | null; confidence: string } {
  const lower = merchant.toLowerCase().trim();

  const override = overrideMap.get(lower);
  if (override) {
    return { primary: override.primary || "UNCATEGORIZED", detailed: override.detailed, confidence: "USER_OVERRIDE" };
  }

  const exact = categoryMap.get(lower);
  if (exact) {
    return { primary: exact.primary, detailed: exact.detailed, confidence: "HIGH" };
  }

  for (const [key, val] of categoryMap) {
    if (fuzzyMatch(lower, key)) {
      return { primary: val.primary, detailed: val.detailed, confidence: "MEDIUM" };
    }
  }

  for (const [keyword, cat] of Object.entries(KEYWORD_CATEGORIES)) {
    if (lower.includes(keyword)) {
      return { primary: cat.primary, detailed: cat.detailed, confidence: "LOW" };
    }
  }

  return { primary: "UNCATEGORIZED", detailed: null, confidence: "NONE" };
}

function generateTransactionId(date: string, amount: number, description: string, index: number): string {
  const hash = crypto.createHash("sha256")
    .update(`${date}|${amount}|${description}|${index}`)
    .digest("hex")
    .slice(0, 16);
  return `csv-${hash}`;
}

export async function importCSVTransactions(
  csvContent: string,
  mapping: ColumnMapping,
  accountId: string,
  itemId: string,
): Promise<ImportResult> {
  const { rows } = parseCSV(csvContent);
  const result: ImportResult = { imported: 0, skipped: 0, errors: [] };

  if (rows.length === 0) {
    result.errors.push("No data rows found in CSV");
    return result;
  }

  const existingAccount = await db.select().from(plaidAccounts).where(eq(plaidAccounts.accountId, accountId));
  if (existingAccount.length === 0) {
    const accountLabel = accountId.replace(/^manual-import-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || "CSV Import";
    await db.insert(plaidAccounts).values({
      accountId,
      itemId,
      name: accountLabel,
      type: "depository",
      subtype: "checking",
      lastUpdated: new Date(),
    }).onConflictDoNothing();
  }

  const existingTxns = await db.select({
    date: plaidTransactions.date,
    amount: plaidTransactions.amount,
    name: plaidTransactions.name,
    merchantName: plaidTransactions.merchantName,
  }).from(plaidTransactions);

  const dedupSet = new Set<string>();
  for (const t of existingTxns) {
    const merchant = (t.merchantName || t.name || "").toLowerCase().trim();
    dedupSet.add(`${t.date}|${t.amount}|${merchant}`);
    const extracted = extractMerchant(t.name || "").toLowerCase().trim();
    if (extracted !== merchant) {
      dedupSet.add(`${t.date}|${t.amount}|${extracted}`);
    }
  }

  const toInsert: Array<{
    transactionId: string;
    accountId: string;
    itemId: string;
    date: string;
    amount: number;
    name: string;
    merchantName: string | null;
    categoryPrimary: string | null;
    categoryDetailed: string | null;
    categoryConfidence: string | null;
    pending: boolean;
    source: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNum = i + 2;

    const rawDate = row[mapping.date];
    const rawDescription = row[mapping.description];

    if (!rawDate || !rawDescription) {
      result.errors.push(`Row ${lineNum}: missing date or description`);
      result.skipped++;
      continue;
    }

    const date = normalizeDate(rawDate);
    if (!date) {
      result.errors.push(`Row ${lineNum}: invalid date "${rawDate}"`);
      result.skipped++;
      continue;
    }

    let amount: number | null = null;
    if (mapping.debit !== undefined && mapping.credit !== undefined) {
      const debitVal = row[mapping.debit] ? parseAmount(row[mapping.debit]) : null;
      const creditVal = row[mapping.credit] ? parseAmount(row[mapping.credit]) : null;
      if (debitVal !== null) amount = Math.abs(debitVal);
      else if (creditVal !== null) amount = -Math.abs(creditVal);
    } else {
      amount = parseAmount(row[mapping.amount]);
    }

    if (amount === null) {
      result.errors.push(`Row ${lineNum}: invalid amount`);
      result.skipped++;
      continue;
    }

    const description = rawDescription.trim();
    const merchant = extractMerchant(description);
    const dedupKey = `${date}|${amount}|${merchant.toLowerCase().trim()}`;

    if (dedupSet.has(dedupKey)) {
      result.skipped++;
      continue;
    }
    dedupSet.add(dedupKey);

    const txnId = generateTransactionId(date, amount, description, i);

    toInsert.push({
      transactionId: txnId,
      accountId,
      itemId,
      date,
      amount,
      name: description,
      merchantName: merchant !== description ? merchant : null,
      categoryPrimary: null,
      categoryDetailed: null,
      categoryConfidence: null,
      pending: false,
      source: "csv_import",
    });
  }

  if (toInsert.length > 0) {
    let actualInserted = 0;
    const batchSize = 100;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      const inserted = await db.insert(plaidTransactions).values(batch).onConflictDoNothing().returning({ id: plaidTransactions.id });
      actualInserted += inserted.length;
    }
    result.imported = actualInserted;
    result.skipped += toInsert.length - actualInserted;
  }

  return result;
}

export function previewCSVImport(
  csvContent: string,
  mapping: ColumnMapping,
): ParsedRow[] {
  const { rows } = parseCSV(csvContent);
  const preview: ParsedRow[] = [];

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    const rawDate = row[mapping.date];
    const rawDescription = row[mapping.description];
    if (!rawDate || !rawDescription) continue;

    const date = normalizeDate(rawDate);
    if (!date) continue;

    let amount: number | null = null;
    if (mapping.debit !== undefined && mapping.credit !== undefined) {
      const debitVal = row[mapping.debit] ? parseAmount(row[mapping.debit]) : null;
      const creditVal = row[mapping.credit] ? parseAmount(row[mapping.credit]) : null;
      if (debitVal !== null) amount = Math.abs(debitVal);
      else if (creditVal !== null) amount = -Math.abs(creditVal);
    } else {
      amount = parseAmount(row[mapping.amount]);
    }

    if (amount === null) continue;

    preview.push({ date, description: rawDescription.trim(), amount });
  }

  return preview;
}
