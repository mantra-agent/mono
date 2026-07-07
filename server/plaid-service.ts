import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { db } from "./db";
import {
  plaidAccounts, plaidTransactions, plaidSecurities,
  plaidHoldings, plaidLiabilities, plaidSyncCursors,
  manualAssets, manualLiabilities, recurringExpenses,
  financedAssets, manual401kAccounts,
  merchantCategoryOverrides, expenseCategories,
} from "@shared/schema";
import { eq, and, gte, lte, inArray, desc, sql, count } from "drizzle-orm";
import { createAccount, listAccounts, updateAccount, getAccount, getAccountTokens } from "./connected-accounts";
import { getSecretSync, onSecretChange } from "./secrets-store";
import { createLogger } from "./log";
import { sensitiveOwnershipValues } from "./sensitive-scope";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { visibleFinanceForCurrentPrincipal } from "./finance-scope";
import { calculateNetWorthComponents } from "./forecast-helpers";
import crypto from "crypto";

const log = createLogger("PlaidService");

const BATCH_SIZE = 100;
const _syncingItems = new Set<string>();
const _syncPhase = new Map<string, string>();

type PlaidErrorResponse = {
  status?: number;
  data?: {
    error_type?: string;
    error_code?: string;
    error_code_reason?: string | null;
    error_message?: string;
    display_message?: string | null;
    request_id?: string;
    documentation_url?: string;
    suggested_action?: string;
  };
};

function formatPlaidError(err: unknown): string {
  const fallback = err instanceof Error ? err.message : String(err);
  if (!err || typeof err !== "object") return fallback;

  const response = (err as { response?: PlaidErrorResponse }).response;
  const data = response?.data;
  if (!response && !data) return fallback;

  const parts = [
    response?.status ? `HTTP ${response.status}` : null,
    data?.error_type ?? null,
    data?.error_code ?? null,
    data?.error_code_reason ? `reason=${data.error_code_reason}` : null,
    data?.error_message ?? fallback,
    data?.display_message ? `display=${data.display_message}` : null,
    data?.suggested_action ? `action=${data.suggested_action}` : null,
    data?.request_id ? `request_id=${data.request_id}` : null,
    data?.documentation_url ? `docs=${data.documentation_url}` : null,
  ].filter((part): part is string => !!part);

  return parts.length > 0 ? parts.join(" | ") : fallback;
}

let _cachedClient: PlaidApi | null = null;

onSecretChange((name) => {
  if (name === "PLAID_CLIENT_ID" || name === "PLAID_SECRET" || name === "PLAID_ENV") {
    _cachedClient = null;
  }
});

function getClient(): PlaidApi {
  if (_cachedClient) return _cachedClient;
  const clientId = getSecretSync("PLAID_CLIENT_ID");
  const secret = getSecretSync("PLAID_SECRET");
  const envKey = getSecretSync("PLAID_ENV") as keyof typeof PlaidEnvironments | undefined;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
  }
  if (!envKey || !(envKey in PlaidEnvironments)) {
    throw new Error(
      `PLAID_ENV must be set to one of: ${Object.keys(PlaidEnvironments).join(", ")}`
    );
  }
  const configuration = new Configuration({
    basePath: PlaidEnvironments[envKey],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  _cachedClient = new PlaidApi(configuration);
  return _cachedClient;
}

export function isPlaidConfigured(): boolean {
  const envKey = getSecretSync("PLAID_ENV") as keyof typeof PlaidEnvironments | undefined;
  return !!(
    getSecretSync("PLAID_CLIENT_ID") &&
    getSecretSync("PLAID_SECRET") &&
    envKey &&
    envKey in PlaidEnvironments
  );
}

export interface PlaidConfigDiagnostics {
  configured: boolean;
  missing: string[];
  invalid: string[];
  details: {
    PLAID_CLIENT_ID: { set: boolean };
    PLAID_SECRET: { set: boolean };
    PLAID_ENV: { set: boolean; value: string | null; valid: boolean; validValues: string[] };
  };
}

export function getPlaidConfigDiagnostics(): PlaidConfigDiagnostics {
  const validValues = ["sandbox", "development", "production"];
  const clientId = getSecretSync("PLAID_CLIENT_ID");
  const secret = getSecretSync("PLAID_SECRET");
  const envKey = getSecretSync("PLAID_ENV");

  const missing: string[] = [];
  const invalid: string[] = [];

  if (!clientId) missing.push("PLAID_CLIENT_ID");
  if (!secret) missing.push("PLAID_SECRET");
  if (!envKey) {
    missing.push("PLAID_ENV");
  } else if (!validValues.includes(envKey)) {
    invalid.push("PLAID_ENV");
  }

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    details: {
      PLAID_CLIENT_ID: { set: !!clientId },
      PLAID_SECRET: { set: !!secret },
      PLAID_ENV: {
        set: !!envKey,
        value: envKey || null,
        valid: !!envKey && validValues.includes(envKey),
        validValues,
      },
    },
  };
}

function getWebhookUrl(): string {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "") || "";
  return `${base}/api/plaid/webhook`;
}

export async function createLinkToken(): Promise<{ linkToken: string }> {
  const client = getClient();
  const webhookUrl = getWebhookUrl();

  const response = await client.linkTokenCreate({
    user: { client_user_id: "xyz-user-1" },
    client_name: "xyz Finance",
    products: [Products.Transactions],
    additional_consented_products: [Products.Investments, Products.Liabilities],
    country_codes: [CountryCode.Us],
    language: "en",
    webhook: webhookUrl,
  });

  log.log("Created link token");
  return { linkToken: response.data.link_token };
}

export async function exchangePublicToken(publicToken: string): Promise<{
  itemId: string;
  accountId: string;
}> {
  const client = getClient();

  const exchangeResponse = await client.itemPublicTokenExchange({
    public_token: publicToken,
  });

  const accessToken = exchangeResponse.data.access_token;
  const itemId = exchangeResponse.data.item_id;

  const itemResponse = await client.itemGet({ access_token: accessToken });
  const institutionId = itemResponse.data.item.institution_id || "unknown";

  let institutionName = institutionId;
  try {
    if (institutionId !== "unknown") {
      const instResponse = await client.institutionsGetById({
        institution_id: institutionId,
        country_codes: [CountryCode.Us],
      });
      institutionName = instResponse.data.institution.name;
    }
  } catch (err: unknown) {
    log.warn(`Could not fetch institution name: ${err instanceof Error ? err.message : String(err)}`);
  }

  const accountId = `plaid-${itemId}`;
  await createAccount({
    accountId,
    provider: "plaid",
    label: institutionName,
    tokens: {
      access_token: accessToken,
      item_id: itemId,
      institution_id: institutionId,
      institution_name: institutionName,
    },
  });

  log.log(`Exchanged public token for item ${itemId} (${institutionName})`);

  await syncAccounts(itemId, accessToken);

  return { itemId, accountId };
}

interface PlaidTokens {
  access_token: string;
  item_id: string;
  institution_name?: string;
}

function asPlaidTokens(tokens: unknown): PlaidTokens | null {
  if (tokens && typeof tokens === "object" && "access_token" in tokens && "item_id" in tokens) {
    return tokens as PlaidTokens;
  }
  return null;
}

async function getDecryptedPlaidTokens(accountId: string): Promise<PlaidTokens | null> {
  const raw = await getAccountTokens(accountId);
  return asPlaidTokens(raw);
}

async function getAllPlaidTokens(): Promise<Map<string, PlaidTokens>> {
  const accounts = await listAccounts("plaid");
  const tokenMap = new Map<string, PlaidTokens>();
  const results = await Promise.all(
    accounts.map(a => getDecryptedPlaidTokens(a.accountId).then(t => ({ accountId: a.accountId, tokens: t })))
  );
  for (const { accountId, tokens } of results) {
    if (tokens) tokenMap.set(accountId, tokens);
  }
  return tokenMap;
}

export async function getAccessToken(itemId: string): Promise<string> {
  const tokenMap = await getAllPlaidTokens();
  for (const tokens of tokenMap.values()) {
    if (tokens.item_id === itemId) return tokens.access_token;
  }

  const accounts = await listAccounts("plaid");
  for (const acct of accounts) {
    try {
      const tokens = await getDecryptedPlaidTokens(acct.accountId);
      if (tokens?.item_id === itemId) {
        log.log(`getAccessToken: found token for ${itemId} via direct account fallback (${acct.accountId})`);
        return tokens.access_token;
      }
    } catch (err: unknown) {
      log.warn(`getAccessToken fallback skipped account=${acct.accountId} itemId=${itemId}: failed to decrypt tokens: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`No access token found for Plaid item ${itemId} across ${accounts.length} accounts`);
}

async function getAccessTokenByAccountId(accountId: string): Promise<{ accessToken: string; itemId: string } | null> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== "plaid") return null;
  const t = await getDecryptedPlaidTokens(accountId);
  if (!t) return null;
  return { accessToken: t.access_token, itemId: t.item_id };
}

export async function getPlaidItems(): Promise<Array<{ accountId: string; itemId: string; institutionName: string; healthy: boolean; healthError: string | null }>> {
  const accounts = await listAccounts("plaid");
  const tokenMap = await getAllPlaidTokens();
  return accounts.map(a => {
    const t = tokenMap.get(a.accountId);
    return {
      accountId: a.accountId,
      itemId: t?.item_id || "",
      institutionName: t?.institution_name || a.label,
      healthy: a.healthy ?? true,
      healthError: a.healthError ?? null,
    };
  });
}

export async function syncAccounts(itemId: string, accessToken: string): Promise<void> {
  const client = getClient();
  const response = await client.accountsGet({ access_token: accessToken });
  const now = new Date();

  for (let i = 0; i < response.data.accounts.length; i += BATCH_SIZE) {
    const batch = response.data.accounts.slice(i, i + BATCH_SIZE);
    const rows = batch.map(acct => ({
      accountId: acct.account_id,
      itemId,
      name: acct.name,
      officialName: acct.official_name || null,
      type: acct.type,
      subtype: acct.subtype || null,
      mask: acct.mask || null,
      currencyCode: acct.balances.iso_currency_code || "USD",
      currentBalance: acct.balances.current,
      availableBalance: acct.balances.available,
      creditLimit: acct.balances.limit,
      lastUpdated: now,
    }));
    if (rows.length > 0) {
      await db
        .insert(plaidAccounts)
        .values(rows.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })))
        .onConflictDoUpdate({
          target: plaidAccounts.accountId,
          set: {
            name: sql`excluded.name`,
            officialName: sql`excluded.official_name`,
            type: sql`excluded.type`,
            subtype: sql`excluded.subtype`,
            mask: sql`excluded.mask`,
            currencyCode: sql`excluded.currency_code`,
            currentBalance: sql`excluded.current_balance`,
            availableBalance: sql`excluded.available_balance`,
            creditLimit: sql`excluded.credit_limit`,
            lastUpdated: sql`excluded.last_updated`,
          },
        });
    }
  }

  log.log(`Synced ${response.data.accounts.length} accounts for item ${itemId}`);
}

interface PlaidTxnLike {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  iso_currency_code?: string | null;
  name: string;
  merchant_name?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string } | null;
  pending: boolean;
  location?: { city?: string | null; region?: string | null } | null;
}

function mapTransactionFields(txn: PlaidTxnLike) {
  return {
    date: txn.date,
    amount: txn.amount,
    name: txn.name,
    merchantName: txn.merchant_name || null,
    categoryPrimary: txn.personal_finance_category?.primary || null,
    categoryDetailed: txn.personal_finance_category?.detailed || null,
    categoryConfidence: txn.personal_finance_category?.confidence_level || null,
    pending: txn.pending,
    locationCity: txn.location?.city || null,
    locationRegion: txn.location?.region || null,
  };
}

function mapTransactionInsert(txn: PlaidTxnLike, itemId: string) {
  return {
    transactionId: txn.transaction_id,
    accountId: txn.account_id,
    itemId,
    currencyCode: txn.iso_currency_code || "USD",
    ...mapTransactionFields(txn),
  };
}

const TRANSACTION_CONFLICT_SET = {
  date: sql`excluded.date`,
  amount: sql`excluded.amount`,
  name: sql`excluded.name`,
  merchantName: sql`excluded.merchant_name`,
  categoryPrimary: sql`excluded.category_primary`,
  categoryDetailed: sql`excluded.category_detailed`,
  categoryConfidence: sql`excluded.category_confidence`,
  pending: sql`excluded.pending`,
  locationCity: sql`excluded.location_city`,
  locationRegion: sql`excluded.location_region`,
};

async function persistSyncPage(
  itemId: string,
  added: PlaidTxnLike[],
  modified: PlaidTxnLike[],
  removed: Array<{ transaction_id?: string }>,
): Promise<{ addedCount: number; modifiedCount: number; removedCount: number }> {
  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;

  for (let i = 0; i < added.length; i += BATCH_SIZE) {
    const batch = added.slice(i, i + BATCH_SIZE);
    const rows = batch.map(txn => mapTransactionInsert(txn, itemId));
    if (rows.length > 0) {
      await db
        .insert(plaidTransactions)
        .values(rows.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })))
        .onConflictDoUpdate({
          target: plaidTransactions.transactionId,
          set: TRANSACTION_CONFLICT_SET,
        });
      addedCount += rows.length;
    }
  }

  for (let i = 0; i < modified.length; i += BATCH_SIZE) {
    const batch = modified.slice(i, i + BATCH_SIZE);
    const rows = batch.map(txn => mapTransactionInsert(txn, itemId));
    if (rows.length > 0) {
      await db
        .insert(plaidTransactions)
        .values(rows.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })))
        .onConflictDoUpdate({
          target: plaidTransactions.transactionId,
          set: TRANSACTION_CONFLICT_SET,
        });
      modifiedCount += rows.length;
    }
  }

  const removeIds = removed.map(r => r.transaction_id).filter((id): id is string => !!id);
  for (let i = 0; i < removeIds.length; i += BATCH_SIZE) {
    const batch = removeIds.slice(i, i + BATCH_SIZE);
    await db.delete(plaidTransactions).where(inArray(plaidTransactions.transactionId, batch));
    removedCount += batch.length;
  }

  return { addedCount, modifiedCount, removedCount };
}

function computeDateRange(txns: PlaidTxnLike[]): string {
  if (txns.length === 0) return "none";
  let min = txns[0].date;
  let max = txns[0].date;
  for (const t of txns) {
    if (t.date < min) min = t.date;
    if (t.date > max) max = t.date;
  }
  return `${min}..${max}`;
}

async function detectPartialSync(itemId: string, isInitialSync: boolean, totalAdded: number): Promise<boolean> {
  const [localCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(plaidTransactions)
    .where(eq(plaidTransactions.itemId, itemId));
  const totalLocal = localCount?.count ?? 0;

  const perAccountCounts = await db
    .select({ accountId: plaidTransactions.accountId, count: sql<number>`count(*)::int` })
    .from(plaidTransactions)
    .where(eq(plaidTransactions.itemId, itemId))
    .groupBy(plaidTransactions.accountId);

  const linkedAccounts = await db
    .select({ accountId: plaidAccounts.accountId, name: plaidAccounts.name, type: plaidAccounts.type, subtype: plaidAccounts.subtype })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.itemId, itemId));

  const ZERO_TXN_OK_TYPES = new Set(["credit", "loan", "investment", "other"]);

  const countByAccount = new Map(perAccountCounts.map(r => [r.accountId, r.count]));
  const emptyAccounts = linkedAccounts.filter(a => {
    const isEmpty = !countByAccount.has(a.accountId) || countByAccount.get(a.accountId) === 0;
    return isEmpty && !ZERO_TXN_OK_TYPES.has(a.type?.toLowerCase() || "");
  });

  const hasDiscrepancy = isInitialSync && totalLocal !== totalAdded;
  const hasEmptyAccounts = isInitialSync && emptyAccounts.length > 0;
  const needsInvestigation = hasDiscrepancy || hasEmptyAccounts;

  if (needsInvestigation) {
    const reasons: string[] = [];
    if (hasDiscrepancy) reasons.push(`added=${totalAdded} but localCount=${totalLocal}`);
    if (hasEmptyAccounts) reasons.push(`${emptyAccounts.length} account(s) with 0 transactions: ${emptyAccounts.map(a => a.name).join(", ")}`);
    const msg = reasons.join("; ");
    log.log(`[PARTIAL_SYNC] ${itemId}: ${msg}`);
    await db
      .update(plaidSyncCursors)
      .set({ needsInvestigation: true, syncError: `Partial sync: ${msg}` })
      .where(eq(plaidSyncCursors.itemId, itemId));
  }

  return needsInvestigation;
}

export async function syncTransactions(itemId: string, _callerHoldsLock = false): Promise<{ added: number; modified: number; removed: number }> {
  if (!_callerHoldsLock && _syncingItems.has(itemId)) {
    throw new Error(`syncTransactions: item ${itemId} is already syncing — concurrent calls are not allowed`);
  }
  const ownsLock = !_callerHoldsLock;
  _syncingItems.add(itemId);

  let added = 0;
  let modified = 0;
  let removed = 0;
  let pagesCompleted = 0;

  try {
    const accessToken = await getAccessToken(itemId);
    const client = getClient();

    const cursorRows = await db.select().from(plaidSyncCursors).where(eq(plaidSyncCursors.itemId, itemId)).limit(1);
    let cursor = cursorRows[0]?.cursor || undefined;
    const isInitialSync = !cursor;

    let hasMore = true;

    await db
      .insert(plaidSyncCursors)
      .values({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), itemId, cursor: cursor || null, lastSynced: new Date(), syncStatus: "syncing", pagesCompleted: 0, totalAdded: 0, syncError: null, syncStartedAt: new Date(), lastSyncAttempt: new Date(), needsInvestigation: false })
      .onConflictDoUpdate({
        target: plaidSyncCursors.itemId,
        set: { syncStatus: "syncing", pagesCompleted: 0, totalAdded: 0, syncError: null, syncStartedAt: new Date(), lastSyncAttempt: new Date() },
      });

    log.log(`[SYNC_START] ${itemId}: initial=${isInitialSync}, cursor=${cursor ? cursor.substring(0, 16) + "..." : "none"}`);

    while (hasMore) {
      const prevCursor = cursor;
      const response = await client.transactionsSync({
        access_token: accessToken,
        cursor: cursor || undefined,
      });

      const data = response.data;
      const pageAdded = data.added as PlaidTxnLike[];
      const pageModified = data.modified as PlaidTxnLike[];
      const pageRemoved = data.removed;

      const dateRange = computeDateRange([...pageAdded, ...pageModified] as PlaidTxnLike[]);

      const pageCounts = await persistSyncPage(itemId, pageAdded, pageModified, pageRemoved);

      added += pageCounts.addedCount;
      modified += pageCounts.modifiedCount;
      removed += pageCounts.removedCount;
      cursor = data.next_cursor;
      hasMore = data.has_more;
      pagesCompleted++;

      const prevShort = prevCursor ? prevCursor.substring(0, 12) : "none";
      const nextShort = cursor ? cursor.substring(0, 12) : "none";
      log.log(`[SYNC_PAGE] ${itemId}: page=${pagesCompleted} +${pageCounts.addedCount} ~${pageCounts.modifiedCount} -${pageCounts.removedCount} dates=${dateRange} cursor=${prevShort}→${nextShort} hasMore=${hasMore} reportedTotal=${data.added.length}+${data.modified.length}+${data.removed.length}`);

      await db
        .update(plaidSyncCursors)
        .set({ cursor: cursor || null, lastSynced: new Date(), pagesCompleted, totalAdded: added })
        .where(eq(plaidSyncCursors.itemId, itemId));
    }

    await finalizeSyncSuccess(itemId, { added, modified, removed, pagesCompleted, isInitialSync });

    // Re-pair internal transfers across the rolling 30d window after every sync
    // so cross-account moves stop polluting income/spend totals on the very
    // next render. Errors must not fail the sync.
    try {
      const { schedulePairingAfterSync } = await import("./finance-internal-transfers");
      await schedulePairingAfterSync(30);
    } catch (err) {
      log.error(`[INTERNAL_TRANSFERS] post-sync pairing failed: ${(err as Error).message}`);
    }

    return { added, modified, removed };
  } catch (err: unknown) {
    await finalizeSyncError(itemId, err, { added, modified, removed, pagesCompleted });
    throw err;
  } finally {
    if (ownsLock) _syncingItems.delete(itemId);
  }
}

async function finalizeSyncSuccess(
  itemId: string,
  stats: { added: number; modified: number; removed: number; pagesCompleted: number; isInitialSync: boolean },
): Promise<void> {
  await db
    .update(plaidSyncCursors)
    .set({ syncStatus: "idle", pagesCompleted: stats.pagesCompleted, totalAdded: stats.added, syncError: null, lastSynced: new Date() })
    .where(eq(plaidSyncCursors.itemId, itemId));

  const isPartial = await detectPartialSync(itemId, stats.isInitialSync, stats.added);

  if (!isPartial && stats.isInitialSync) {
    await db
      .update(plaidSyncCursors)
      .set({ needsInvestigation: false })
      .where(eq(plaidSyncCursors.itemId, itemId));
  }

  log.log(`[SYNC_COMPLETE] ${itemId}: +${stats.added} ~${stats.modified} -${stats.removed} (${stats.pagesCompleted} pages, initial=${stats.isInitialSync})`);
}

async function finalizeSyncError(
  itemId: string,
  err: unknown,
  stats: { added: number; modified: number; removed: number; pagesCompleted: number },
): Promise<void> {
  const msg = formatPlaidError(err);
  log.error(`[SYNC_ERROR] ${itemId}: after ${stats.pagesCompleted} pages, +${stats.added} ~${stats.modified} -${stats.removed}: ${msg}`);
  await db
    .update(plaidSyncCursors)
    .set({ syncStatus: "error", syncError: msg, pagesCompleted: stats.pagesCompleted, totalAdded: stats.added })
    .where(eq(plaidSyncCursors.itemId, itemId));
}

export function isItemSyncing(itemId: string): boolean {
  return _syncingItems.has(itemId);
}

export function getSyncPhase(itemId: string): string | null {
  return _syncPhase.get(itemId) || null;
}

export async function fetchHoldings(itemId: string): Promise<number> {
  const accessToken = await getAccessToken(itemId);
  const client = getClient();

  const HOLDINGS_SKIP_ERRORS = new Set([
    "PRODUCTS_NOT_SUPPORTED",
    "PRODUCT_NOT_READY",
    "NO_INVESTMENT_ACCOUNTS",
    "INVALID_PRODUCT",
  ]);

  let response;
  try {
    response = await client.investmentsHoldingsGet({ access_token: accessToken });
  } catch (err: unknown) {
    const plaidErr = err as { response?: { data?: { error_code?: string }, status?: number } };
    const errorCode = plaidErr?.response?.data?.error_code || "";
    const httpStatus = plaidErr?.response?.status;
    if (HOLDINGS_SKIP_ERRORS.has(errorCode) || httpStatus === 400) {
      log.debug(`Holdings not available for item ${itemId} (${errorCode || `HTTP ${httpStatus}`})`);
      return 0;
    }
    throw err;
  }

  const { holdings, securities } = response.data;
  const now = new Date();

  for (let i = 0; i < securities.length; i += BATCH_SIZE) {
    const batch = securities.slice(i, i + BATCH_SIZE);
    const rows = batch.map(sec => ({
      securityId: sec.security_id,
      name: sec.name || null,
      tickerSymbol: sec.ticker_symbol || null,
      type: sec.type || null,
      closePrice: sec.close_price || null,
      closePriceAsOf: sec.close_price_as_of || null,
      currencyCode: sec.iso_currency_code || "USD",
      lastUpdated: now,
    }));
    if (rows.length > 0) {
      await db
        .insert(plaidSecurities)
        .values(rows)
        .onConflictDoUpdate({
          target: plaidSecurities.securityId,
          set: {
            name: sql`excluded.name`,
            tickerSymbol: sql`excluded.ticker_symbol`,
            type: sql`excluded.type`,
            closePrice: sql`excluded.close_price`,
            closePriceAsOf: sql`excluded.close_price_as_of`,
            currencyCode: sql`excluded.currency_code`,
            lastUpdated: sql`excluded.last_updated`,
          },
        });
    }
  }

  await db.delete(plaidHoldings).where(eq(plaidHoldings.itemId, itemId));

  const holdingRows = holdings.map(h => ({
    accountId: h.account_id,
    itemId,
    securityId: h.security_id,
    quantity: h.quantity,
    costBasis: h.cost_basis || null,
    institutionValue: h.institution_value || null,
    institutionPrice: h.institution_price || null,
    currencyCode: h.iso_currency_code || "USD",
    lastUpdated: now,
  }));

  for (let i = 0; i < holdingRows.length; i += BATCH_SIZE) {
    const batch = holdingRows.slice(i, i + BATCH_SIZE);
    if (batch.length > 0) {
      await db.insert(plaidHoldings).values(batch.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })));
    }
  }

  log.log(`Fetched ${holdings.length} holdings, ${securities.length} securities for item ${itemId}`);
  return holdings.length;
}

export async function fetchLiabilities(itemId: string): Promise<number> {
  const accessToken = await getAccessToken(itemId);

  const client = getClient();

  let response;
  try {
    response = await client.liabilitiesGet({ access_token: accessToken });
  } catch (err: unknown) {
    const plaidErr = err as { response?: { data?: { error_code?: string }, status?: number } };
    const errorCode = plaidErr?.response?.data?.error_code || "";
    const httpStatus = plaidErr?.response?.status;
    if (errorCode === "PRODUCTS_NOT_SUPPORTED" || httpStatus === 400) {
      log.debug(`Liabilities not available for item ${itemId} (${errorCode || `HTTP ${httpStatus}`}) — falling back to account balances`);
      const fallbackCount = await createLiabilitiesFromAccounts(itemId);
      log.log(`Fetched ${fallbackCount} liabilities (fallback) for item ${itemId}`);
      return fallbackCount;
    }
    throw err;
  }

  const { liabilities } = response.data;
  const rows: (typeof plaidLiabilities.$inferInsert)[] = [];
  const now = new Date();

  await db.delete(plaidLiabilities).where(eq(plaidLiabilities.itemId, itemId));

  if (liabilities.credit) {
    for (const credit of liabilities.credit) {
      const aprs = credit.aprs || [];
      const purchaseApr = aprs.find((a: { apr_type?: string }) => a.apr_type === "purchase_apr");
      rows.push({
        accountId: credit.account_id || "",
        itemId,
        liabilityType: "credit",
        balance: credit.last_statement_balance || null,
        creditLimit: null,
        aprPercentage: purchaseApr?.apr_percentage || null,
        aprType: purchaseApr?.apr_type || null,
        minimumPayment: credit.minimum_payment_amount || null,
        nextPaymentDueDate: credit.next_payment_due_date || null,
        interestRatePercentage: null,
        originationDate: null,
        loanTerm: null,
        lastUpdated: now,
      });
    }
  }

  if (liabilities.student) {
    for (const student of liabilities.student) {
      const studentAcct = response.data.accounts?.find(
        (a: { account_id: string }) => a.account_id === student.account_id
      );
      rows.push({
        accountId: student.account_id || "",
        itemId,
        liabilityType: "student",
        balance: studentAcct?.balances?.current ?? null,
        creditLimit: null,
        aprPercentage: null,
        aprType: null,
        minimumPayment: student.minimum_payment_amount || null,
        nextPaymentDueDate: student.next_payment_due_date || null,
        interestRatePercentage: student.interest_rate_percentage || null,
        originationDate: student.origination_date || null,
        loanTerm: null,
        lastUpdated: now,
      });
    }
  }

  if (liabilities.mortgage) {
    for (const mortgage of liabilities.mortgage) {
      const mortgageAcct = response.data.accounts?.find(
        (a: { account_id: string }) => a.account_id === mortgage.account_id
      );
      rows.push({
        accountId: mortgage.account_id || "",
        itemId,
        liabilityType: "mortgage",
        balance: mortgageAcct?.balances?.current ?? null,
        creditLimit: null,
        aprPercentage: null,
        aprType: null,
        minimumPayment: mortgage.last_payment_amount || null,
        nextPaymentDueDate: mortgage.next_payment_due_date || null,
        interestRatePercentage: (mortgage as any).interest_rate_percentage || null,
        originationDate: mortgage.origination_date || null,
        loanTerm: mortgage.loan_term || null,
        lastUpdated: now,
      });
    }
  }

  if (rows.length > 0) {
    await db.insert(plaidLiabilities).values(rows.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })));
  }

  const backfillCount = await createLiabilitiesFromAccounts(itemId);
  const count = rows.length + backfillCount;

  log.log(`Fetched ${count} liabilities (${backfillCount} backfilled) for item ${itemId}`);
  return count;
}

async function createLiabilitiesFromAccounts(itemId: string): Promise<number> {
  const accounts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.itemId, itemId));
  const creditLoanAccounts = accounts.filter(a => a.type === "credit" || a.type === "loan");
  if (creditLoanAccounts.length === 0) return 0;

  const existing = await db.select({ accountId: plaidLiabilities.accountId }).from(plaidLiabilities).where(eq(plaidLiabilities.itemId, itemId));
  const existingIds = new Set(existing.map(e => e.accountId));

  const newRows: (typeof plaidLiabilities.$inferInsert)[] = [];
  const now = new Date();
  for (const acct of creditLoanAccounts) {
    if (existingIds.has(acct.accountId)) continue;
    newRows.push({
      accountId: acct.accountId,
      itemId,
      liabilityType: acct.type === "credit" ? "credit" : "loan",
      balance: acct.currentBalance,
      creditLimit: acct.creditLimit,
      aprPercentage: null,
      aprType: null,
      minimumPayment: null,
      nextPaymentDueDate: null,
      interestRatePercentage: null,
      originationDate: null,
      loanTerm: null,
      lastUpdated: now,
    });
  }
  if (newRows.length > 0) {
    await db.insert(plaidLiabilities).values(newRows.map(row => ({ ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()), ...row })));
    log.log(`Created ${newRows.length} fallback liabilities from account balances for item ${itemId}`);
  }
  return newRows.length;
}

export async function fetchRecurring(itemId: string): Promise<number> {
  const accessToken = await getAccessToken(itemId);

  const client = getClient();
  const accounts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.itemId, itemId));
  const accountIds = accounts.map(a => a.accountId);

  if (accountIds.length === 0) return 0;

  const response = await client.transactionsRecurringGet({
    access_token: accessToken,
    account_ids: accountIds,
  });

  const allStreams = [
    ...(response.data.outflow_streams || []),
    ...(response.data.inflow_streams || []),
  ];

  const outflowStreams = response.data.outflow_streams || [];

  const tagsByStreamId: Map<string, string[]> = new Map();
  for (const stream of allStreams) {
    if (stream.stream_id && stream.transaction_ids?.length) {
      tagsByStreamId.set(stream.stream_id, stream.transaction_ids);
    }
  }

  for (const [streamId, txnIds] of tagsByStreamId) {
    await db
      .update(plaidTransactions)
      .set({ isRecurring: true, recurringStreamId: streamId })
      .where(inArray(plaidTransactions.transactionId, txnIds));
  }

  const existingPatterns = await db.select({ id: recurringExpenses.id, transactionPattern: recurringExpenses.transactionPattern })
    .from(recurringExpenses)
    .where(sql`${recurringExpenses.transactionPattern} IS NOT NULL`);
  const patternToId = new Map(existingPatterns.map(e => [e.transactionPattern, e.id]));

  const now = new Date();
  const newExpenseRows: (typeof recurringExpenses.$inferInsert)[] = [];
  let expenseCount = 0;

  for (const stream of outflowStreams) {
    if (!stream.stream_id || !stream.description) continue;
    const freq = stream.frequency === "MONTHLY" ? "monthly"
      : stream.frequency === "WEEKLY" ? "weekly"
      : stream.frequency === "BIWEEKLY" ? "biweekly"
      : stream.frequency === "ANNUALLY" ? "annual"
      : "monthly";
    const amount = stream.average_amount?.amount
      ? Math.abs(stream.average_amount.amount)
      : (stream.last_amount?.amount ? Math.abs(stream.last_amount.amount) : 0);
    if (amount === 0) continue;

    const category = stream.personal_finance_category?.primary || "OTHER";
    const name = stream.merchant_name || stream.description;

    const existingId = patternToId.get(stream.stream_id);
    if (existingId !== undefined) {
      await db.update(recurringExpenses)
        .set({ amount, name, category, frequency: freq, lastReviewedAt: now })
        .where(eq(recurringExpenses.id, existingId));
    } else {
      newExpenseRows.push({
        name,
        amount,
        frequency: freq,
        category,
        source: "plaid",
        transactionPattern: stream.stream_id,
        isActive: stream.is_active ?? true,
        lastReviewedAt: now,
      });
    }
    expenseCount++;
  }

  if (newExpenseRows.length > 0) {
    await db.insert(recurringExpenses).values(newExpenseRows);
  }

  log.log(`Tagged ${tagsByStreamId.size} recurring streams, synced ${expenseCount} recurring expenses for item ${itemId}`);
  return tagsByStreamId.size;
}

export async function fullSyncItem(itemId: string): Promise<{ added: number; modified: number; removed: number; warnings: string[] }> {
  if (_syncingItems.has(itemId)) {
    throw new Error(`fullSyncItem: item ${itemId} is already syncing — concurrent calls are not allowed`);
  }
  const warnings: string[] = [];

  _syncingItems.add(itemId);
  _syncPhase.set(itemId, "accounts");

  try {
    const accessToken = await getAccessToken(itemId);
    await syncAccounts(itemId, accessToken);

    _syncPhase.set(itemId, "transactions");
    const result = await syncTransactions(itemId, true);

    _syncPhase.set(itemId, "recurring");
    try { await fetchRecurring(itemId); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Recurring detection failed for ${itemId}: ${msg}`);
      warnings.push(`Recurring: ${msg}`);
    }

    _syncPhase.set(itemId, "holdings");
    try { await fetchHoldings(itemId); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Holdings fetch failed for ${itemId}: ${msg}`);
      warnings.push(`Holdings: ${msg}`);
    }

    _syncPhase.set(itemId, "liabilities");
    try { await fetchLiabilities(itemId); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`Liabilities fetch failed for ${itemId}: ${msg}`);
      warnings.push(`Liabilities: ${msg}`);
    }

    if (warnings.length > 0) {
      await db
        .update(plaidSyncCursors)
        .set({ syncError: `Partial: ${warnings.join("; ")}` })
        .where(eq(plaidSyncCursors.itemId, itemId));
    }

    return { ...result, warnings };
  } finally {
    _syncingItems.delete(itemId);
    _syncPhase.delete(itemId);
  }
}

export async function forceResync(itemId: string): Promise<{ added: number; modified: number; removed: number; warnings: string[] }> {
  if (_syncingItems.has(itemId)) {
    throw new Error(`Item ${itemId} is currently syncing — wait for the current sync to finish`);
  }

  log.log(`[FORCE_RESYNC] Clearing cursor for item ${itemId} to trigger fresh initial sync`);

  await db
    .update(plaidSyncCursors)
    .set({
      cursor: null,
      syncStatus: "idle",
      syncError: null,
      pagesCompleted: 0,
      totalAdded: 0,
      needsInvestigation: false,
      syncStartedAt: null,
    })
    .where(eq(plaidSyncCursors.itemId, itemId));

  return fullSyncItem(itemId);
}

export async function healStuckSyncs(): Promise<number> {
  const stuckRows = await db
    .select()
    .from(plaidSyncCursors)
    .where(eq(plaidSyncCursors.syncStatus, "syncing"));

  let healed = 0;
  for (const row of stuckRows) {
    if (_syncingItems.has(row.itemId)) {
      log.log(`healStuckSyncs: item ${row.itemId} is actively syncing in-memory — skipping`);
      continue;
    }

    await db
      .update(plaidSyncCursors)
      .set({ syncStatus: "idle", syncError: null })
      .where(eq(plaidSyncCursors.itemId, row.itemId));
    healed++;
    log.log(`Healed stuck sync for item ${row.itemId} (started ${row.syncStartedAt?.toISOString() || "unknown"}) — re-queuing continuation from cursor`);
    syncTransactions(row.itemId).catch((err: unknown) => {
      log.error(`Re-queued sync failed for ${row.itemId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  if (healed > 0) log.log(`Healed ${healed} stuck sync(s) — re-queued continuation from last committed cursor`);
  return healed;
}

export async function refreshAllItems(): Promise<void> {
  const items = await getPlaidItems();

  for (const item of items) {
    try {
      await fullSyncItem(item.itemId);
      await updateAccount(item.accountId, {
        healthy: true,
        healthError: null,
        healthCheckedAt: new Date(),
      });
    } catch (err: unknown) {
      const msg = formatPlaidError(err);
      log.error(`Error refreshing item ${item.itemId}: ${msg}`);
      await updateAccount(item.accountId, {
        healthy: false,
        healthError: msg,
        healthCheckedAt: new Date(),
      });
    }
  }

  log.log(`Refreshed ${items.length} Plaid items`);
}

export async function getAccountsList(): Promise<PlaidAccountSummary[]> {
  const accounts = await db.select().from(plaidAccounts).where(visibleFinanceForCurrentPrincipal(plaidAccounts));
  return accounts.map(a => ({
    accountId: a.accountId,
    itemId: a.itemId,
    name: a.name,
    officialName: a.officialName,
    type: a.type,
    subtype: a.subtype,
    mask: a.mask,
    currentBalance: a.currentBalance,
    availableBalance: a.availableBalance,
    creditLimit: a.creditLimit,
    currencyCode: a.currencyCode,
    lastUpdated: a.lastUpdated ? a.lastUpdated.toISOString() : null,
  }));
}

export interface PlaidAccountSummary {
  accountId: string;
  itemId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  currencyCode: string | null;
  lastUpdated: string | null;
}

export type PlaidTransactionRow = typeof plaidTransactions.$inferSelect;
export type PlaidLiabilityRow = typeof plaidLiabilities.$inferSelect;

export interface HoldingWithSecurity {
  accountId: string;
  securityId: string;
  quantity: number;
  costBasis: number | null;
  institutionValue: number | null;
  institutionPrice: number | null;
  currencyCode: string | null;
  securityName: string | null;
  tickerSymbol: string | null;
  securityType: string | null;
}

export async function getTransactions(filters?: {
  startDate?: string;
  endDate?: string;
  category?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ transactions: PlaidTransactionRow[]; total: number }> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.startDate) conditions.push(gte(plaidTransactions.date, filters.startDate));
  if (filters?.endDate) conditions.push(lte(plaidTransactions.date, filters.endDate));
  if (filters?.category) conditions.push(eq(plaidTransactions.categoryPrimary, filters.category));
  if (filters?.accountId) conditions.push(eq(plaidTransactions.accountId, filters.accountId));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const scopeClause = visibleFinanceForCurrentPrincipal(plaidTransactions, whereClause);

  const countQuery = db.select({ value: count() }).from(plaidTransactions).$dynamic();
  countQuery.where(scopeClause);
  const [{ value: total }] = await countQuery;

  let query = db.select().from(plaidTransactions).where(scopeClause).$dynamic();
  const pageSize = filters?.limit || 50;
  const offset = filters?.offset || 0;
  const results = await query.orderBy(desc(plaidTransactions.date)).limit(pageSize).offset(offset);

  return { transactions: results, total };
}

export async function getHoldingsList(): Promise<HoldingWithSecurity[]> {
  const holdings = await db
    .select()
    .from(plaidHoldings)
    .leftJoin(plaidSecurities, eq(plaidHoldings.securityId, plaidSecurities.securityId))
    .where(visibleFinanceForCurrentPrincipal(plaidHoldings));

  return holdings.map(h => ({
    accountId: h.plaid_holdings.accountId,
    securityId: h.plaid_holdings.securityId,
    quantity: h.plaid_holdings.quantity,
    costBasis: h.plaid_holdings.costBasis,
    institutionValue: h.plaid_holdings.institutionValue,
    institutionPrice: h.plaid_holdings.institutionPrice,
    currencyCode: h.plaid_holdings.currencyCode,
    securityName: h.plaid_securities?.name || null,
    tickerSymbol: h.plaid_securities?.tickerSymbol || null,
    securityType: h.plaid_securities?.type || null,
  }));
}

export async function getLiabilitiesList(): Promise<PlaidLiabilityRow[]> {
  return db.select().from(plaidLiabilities).where(visibleFinanceForCurrentPrincipal(plaidLiabilities));
}

export async function getRecurringTransactions(): Promise<PlaidTransactionRow[]> {
  return db
    .select()
    .from(plaidTransactions)
    .where(visibleFinanceForCurrentPrincipal(plaidTransactions, eq(plaidTransactions.isRecurring, true)))
    .orderBy(desc(plaidTransactions.date));
}

export interface FinanceSummary {
  netWorth: number;
  savingsRate: number | null;
  spendingByCategory: Record<string, number>;
  investmentAllocation: Record<string, number>;
  recurringObligations: number;
  totalAssets: number;
  totalLiabilities: number;
  accountCount: number;
  manualAssetTotal: number;
  manualLiabilityTotal: number;
  plaidAssetTotal: number;
  plaidLiabilityTotal: number;
  timeWindow: string;
  trajectory?: import("./finance-trajectory").TrajectorySnapshot;
}

interface PgLikeError {
  code?: string;
  detail?: string;
}

function isPgLikeError(err: unknown): err is PgLikeError {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const codeOk = rec.code === undefined || typeof rec.code === "string";
  const detailOk = rec.detail === undefined || typeof rec.detail === "string";
  return codeOk && detailOk && (rec.code !== undefined || rec.detail !== undefined);
}

export async function getFinanceSummary(): Promise<FinanceSummary> {
  const accounts = await db.select().from(plaidAccounts).where(visibleFinanceForCurrentPrincipal(plaidAccounts));
  const holdings = await getHoldingsList();

  let plaidAssetTotal = 0;
  let plaidLiabilityTotal = 0;

  for (const acct of accounts) {
    const bal = acct.currentBalance || 0;
    if (acct.type === "depository" || acct.type === "investment") {
      plaidAssetTotal += bal;
    } else if (acct.type === "credit" || acct.type === "loan") {
      plaidLiabilityTotal += Math.abs(bal);
    }
  }

  const manualAssetRows = await db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets));
  const manualLiabilityRows = await db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities));
  const financedAssetRows = await db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets));
  const manual401kRows = await db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts));

  const manualAssetTotal = manualAssetRows.reduce((sum, a) => sum + (a.currentValue || 0), 0);
  const manualLiabilityTotal = manualLiabilityRows.reduce((sum, l) => sum + (l.balance || 0), 0);

  const financedAssetValueTotal = financedAssetRows.reduce((sum, a) => sum + (a.currentValue || 0), 0);
  const financedLoanBalanceTotal = financedAssetRows.reduce((sum, a) => sum + (a.loanBalance || 0), 0);

  const manual401kTotal = manual401kRows.reduce((sum, a) => sum + (a.currentBalance || 0), 0);

  const nwComponents = calculateNetWorthComponents({
    plaidAssetTotal,
    manualAssetTotal,
    financedAssetValueTotal,
    investmentTotal: manual401kTotal,
    cashBalance: 0,
    plaidLiabilityTotal,
    manualLiabilityTotal,
    financedLoanBalanceTotal,
  });
  const totalAssets = nwComponents.totalAssets;
  const totalLiabilities = nwComponents.totalLiabilities;
  const netWorth = nwComponents.netWorth;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

  const recentTxns = await db
    .select()
    .from(plaidTransactions)
    .where(visibleFinanceForCurrentPrincipal(plaidTransactions, gte(plaidTransactions.date, thirtyDaysAgoStr)));

  const overrideRows = await db.select().from(merchantCategoryOverrides);
  const catRows = await db.select().from(expenseCategories);
  const catById = new Map(catRows.map(c => [c.id, c]));
  const merchantMap = new Map(overrideRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

  let income = 0;
  let spending = 0;
  const spendingByCategory: Record<string, number> = {};

  for (const txn of recentTxns) {
    if (txn.amount < 0) {
      income += Math.abs(txn.amount);
    } else {
      spending += txn.amount;
      let cat = txn.categoryPrimary || "UNCATEGORIZED";
      const merchant = (txn.merchantName || txn.name || "").toLowerCase();
      const overrideCatId = merchantMap.get(merchant);
      if (overrideCatId !== undefined) {
        const catObj = catById.get(overrideCatId);
        cat = catObj?.plaidCategory || catObj?.name || cat;
      }
      spendingByCategory[cat] = (spendingByCategory[cat] || 0) + txn.amount;
    }
  }

  const savingsRate = income > 0 ? ((income - spending) / income) * 100 : null;

  const investmentAllocation: Record<string, number> = {};
  const totalInvestmentValue = holdings.reduce((sum: number, h: HoldingWithSecurity) => sum + (h.institutionValue || 0), 0);

  for (const h of holdings) {
    const type = h.securityType || "other";
    investmentAllocation[type] = (investmentAllocation[type] || 0) + (h.institutionValue || 0);
  }

  if (totalInvestmentValue > 0) {
    for (const type in investmentAllocation) {
      investmentAllocation[type] = Math.round((investmentAllocation[type] / totalInvestmentValue) * 10000) / 100;
    }
  }

  const recurringTxns = await getRecurringTransactions();
  const monthlyStreams = new Map<string, number>();
  for (const txn of recurringTxns) {
    if (txn.amount > 0 && txn.recurringStreamId) {
      monthlyStreams.set(txn.recurringStreamId, txn.amount);
    }
  }
  const recurringObligations = Array.from(monthlyStreams.values()).reduce((sum, v) => sum + v, 0);

  const result: FinanceSummary = {
    netWorth: Math.round(netWorth * 100) / 100,
    savingsRate: savingsRate !== null ? Math.round(savingsRate * 100) / 100 : null,
    spendingByCategory,
    investmentAllocation,
    recurringObligations: Math.round(recurringObligations * 100) / 100,
    totalAssets: Math.round(totalAssets * 100) / 100,
    totalLiabilities: Math.round(totalLiabilities * 100) / 100,
    accountCount: accounts.length,
    manualAssetTotal: Math.round(manualAssetTotal * 100) / 100,
    manualLiabilityTotal: Math.round(manualLiabilityTotal * 100) / 100,
    plaidAssetTotal: Math.round(plaidAssetTotal * 100) / 100,
    plaidLiabilityTotal: Math.round(plaidLiabilityTotal * 100) / 100,
    timeWindow: "trailing 30 days",
  };

  try {
    const { getTrajectorySnapshot } = await import("./finance-trajectory");
    result.trajectory = await getTrajectorySnapshot();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const pg = isPgLikeError(err) ? err : null;
    const stack = err instanceof Error ? err.stack : undefined;
    log.warn(
      `[Finance] Trajectory snapshot failed, returning summary without trajectory: ${msg}` +
        (pg?.code ? ` [pg code=${pg.code}]` : "") +
        (pg?.detail ? ` detail=${pg.detail}` : "")
    );
    if (stack) log.warn(stack);
  }

  return result;
}

const processedWebhookIds = new Map<string, number>();

const WEBHOOK_DEDUP_TTL_MS = 5 * 60 * 1000;

export function isWebhookDuplicate(eventId: string): boolean {
  const now = Date.now();
  const existing = processedWebhookIds.get(eventId);
  if (existing && now - existing < WEBHOOK_DEDUP_TTL_MS) {
    return true;
  }
  processedWebhookIds.set(eventId, now);

  if (processedWebhookIds.size > 1000) {
    const cutoff = now - WEBHOOK_DEDUP_TTL_MS;
    for (const [k, ts] of processedWebhookIds.entries()) {
      if (ts < cutoff) processedWebhookIds.delete(k);
    }
  }
  return false;
}

export async function verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const plaidVerification = headers["plaid-verification"];
    if (!plaidVerification) {
      log.warn("No Plaid verification header present");
      const env = getSecretSync("PLAID_ENV") || "sandbox";
      return env === "sandbox";
    }

    const { decodeProtectedHeader, importJWK, jwtVerify } = await import("jose");

    const decodedHeader = decodeProtectedHeader(plaidVerification);
    const kid = decodedHeader.kid;
    if (!kid) {
      log.warn("No kid in JWT header");
      return false;
    }

    const client = getClient();
    const keyResponse = await client.webhookVerificationKeyGet({ key_id: kid });
    const jwk = keyResponse.data.key;

    const publicKey = await importJWK(jwk as unknown as Record<string, unknown>, decodedHeader.alg || "ES256");

    const { payload } = await jwtVerify(plaidVerification, publicKey, {
      algorithms: [decodedHeader.alg || "ES256"],
      maxTokenAge: "5 min",
    });

    const claimedBodyHash = payload.request_body_sha256 as string | undefined;
    if (!claimedBodyHash) {
      log.warn("No request_body_sha256 in webhook JWT payload");
      return false;
    }

    const actualHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    if (claimedBodyHash !== actualHash) {
      log.warn("Webhook body hash mismatch");
      return false;
    }

    return true;
  } catch (err: unknown) {
    log.warn(`Webhook verification failed: ${err instanceof Error ? err.message : String(err)}`);
    const env = getSecretSync("PLAID_ENV") || "sandbox";
    return env === "sandbox";
  }
}

export async function reconcileWebhookUrls(): Promise<void> {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    log.debug("No webhook URL available, skipping reconciliation");
    return;
  }

  const items = await getPlaidItems();
  const client = getClient();

  for (const item of items) {
    try {
      const accessToken = await getAccessToken(item.itemId);
      await client.itemWebhookUpdate({
        access_token: accessToken,
        webhook: webhookUrl,
      });
      log.debug(`Updated webhook URL for item ${item.itemId}`);
    } catch (err: unknown) {
      log.warn(`updateWebhookUrl partial failure itemId=${item.itemId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function removeItem(accountId: string): Promise<boolean> {
  const creds = await getAccessTokenByAccountId(accountId);
  if (!creds) return false;

  try {
    const client = getClient();
    await client.itemRemove({ access_token: creds.accessToken });
  } catch (err: unknown) {
    log.warn(`Failed to remove item from Plaid: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.delete(plaidAccounts).where(eq(plaidAccounts.itemId, creds.itemId));
  await db.delete(plaidTransactions).where(eq(plaidTransactions.itemId, creds.itemId));
  await db.delete(plaidHoldings).where(eq(plaidHoldings.itemId, creds.itemId));
  await db.delete(plaidLiabilities).where(eq(plaidLiabilities.itemId, creds.itemId));
  await db.delete(plaidSyncCursors).where(eq(plaidSyncCursors.itemId, creds.itemId));

  const { deleteAccount } = await import("./connected-accounts");
  await deleteAccount(accountId);

  log.log(`Removed Plaid item ${creds.itemId} and all associated data`);
  return true;
}
