import { cliSdkStream, prewarmWarmPool, isWarmPoolEnabled } from "../server/cli-sdk-adapter";
import { thinkingConfigKey } from "../server/thinking-config";

async function runOne(label: string): Promise<{ ttft: number; firstText: string; events: number }> {
  const t0 = Date.now();
  let firstTextAt = 0;
  let firstText = "";
  let events = 0;
  // Match production trivial-chat shape exactly: no system message, no maxTokens override.
  // (server/index.ts prewarm uses systemPrompt:"" and unset maxTokens for the same reason.)
  const stream = cliSdkStream("claude-haiku-sub", {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    sdkTools: [],
    thinking: { thinking: { type: "disabled" } },
    thinkingBudget: 0,
    routingTier: "fast",
  } as any);
  for await (const ev of stream) {
    events++;
    if (ev.type === "text_delta" && !firstTextAt) {
      firstTextAt = Date.now();
      firstText = (ev as any).text || "";
      break;
    }
  }
  const ttft = firstTextAt ? firstTextAt - t0 : Date.now() - t0;
  console.log(`[${label}] ttft=${ttft}ms events=${events} firstText=${JSON.stringify(firstText.slice(0, 40))}`);
  return { ttft, firstText, events };
}

async function main() {
  console.log(`warmPoolEnabled=${isWarmPoolEnabled()}`);
  if (isWarmPoolEnabled()) {
    console.log("priming pool...");
    const pT0 = Date.now();
    await prewarmWarmPool({
      model: "claude-haiku-sub",
      systemPrompt: "",
      thinkingKey: thinkingConfigKey({ thinking: { type: "disabled" } }),
    });
    console.log(`pool primed in ${Date.now() - pT0}ms`);
    console.log("waiting 4s for CLI subprocess to fully spawn...");
    await new Promise(r => setTimeout(r, 4000));
  }
  const results: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const r = await runOne(`turn-${i}`);
    results.push(r.ttft);
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`\nSUMMARY ttft_ms=[${results.join(",")}]`);
  const sub1k = results.slice(1).filter(x => x < 1000).length;
  console.log(`turns 2-6 under 1000ms: ${sub1k}/5`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
