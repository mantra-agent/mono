import { createLogger } from "../../log";

const log = createLogger("Cortex:Finance");

export async function getFinanceContext(): Promise<string> {
  try {
    const { getFinanceSummary } = await import("../../plaid-service");
    const summary = await getFinanceSummary();

    if (!summary) return "Finance data unavailable.";

    const liquidAssets = summary.plaidAssetTotal + summary.manualAssetTotal;
    const netWorth = summary.netWorth;

    const parts = [
      `Liquid assets: $${Math.round(liquidAssets).toLocaleString()}`,
      `Net worth: $${Math.round(netWorth).toLocaleString()}`,
    ];

    if (liquidAssets < 1000) {
      parts.push("⚠ LOW BALANCE — liquid assets critically low");
    }

    return `Financial snapshot:\n${parts.join("\n")}`;
  } catch (err) {
    log.warn(`Finance source error: ${(err as Error).message}`);
    return "Finance data unavailable.";
  }
}
