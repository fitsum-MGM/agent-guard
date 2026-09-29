import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AgentGuard, explain } from "../src";
import { loadOrCreate } from "./keys";

const OWNER = new PublicKey(
  process.env.OWNER ?? "FCG1cUinpSRdp7Wp5xU1evdMm6us8m5KZHAmdwyy7ppw"
);
const BASE = process.env.BASE_URL ?? "http://localhost:4021";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const agentKey = loadOrCreate("agent");
const guard = new AgentGuard(connection, agentKey);
const anthropic = new Anthropic();

/** The x402-style flow: request, get a 402 quote, pay through Agent Guard, retry with proof. */
async function buyReport(path: string): Promise<string> {
  const url = BASE + path;
  const first = await fetch(url);
  if (first.status !== 402) {
    return `Unexpected response (${first.status}), no payment was required.`;
  }
  const quote: any = await first.json();

  let signature: string;
  try {
    signature = await guard.spend({
      owner: OWNER,
      mint: new PublicKey(quote.mint),
      recipient: new PublicKey(quote.payTo),
      amount: BigInt(quote.amount),
    });
  } catch (e) {
    return `Payment blocked by Agent Guard: ${explain(e)}`;
  }

  const second = await fetch(url, { headers: { "X-Payment": signature } });
  if (!second.ok) return `Paid (${signature.slice(0, 12)}...) but the server rejected it.`;
  const data = await second.json();
  return `Paid ${Number(quote.amount) / 10 ** quote.decimals} USDC and received: ${JSON.stringify(data)}`;
}

const tools: Anthropic.Tool[] = [
  {
    name: "buy_report",
    description:
      "Buy a report from the given API path. If the server requires payment (HTTP 402), " +
      "this automatically pays through Agent Guard, which enforces the caller's spending policy " +
      "on-chain, and returns the report on success.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "API path, e.g. /report or /shady-report" },
      },
      required: ["path"],
    },
  },
];

async function runAgent(task: string) {
  console.log(`\n=== Task: ${task} ===`);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let turn = 0; turn < 5; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) console.log("Claude:", block.text.trim());
    }

    if (response.stop_reason !== "tool_use") break;
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { path: string };
      console.log(`   [tool call] buy_report(${input.path})`);
      const result = await buyReport(input.path);
      console.log(`   [tool result] ${result}`);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }
}

async function main() {
  console.log("agent wallet:", agentKey.publicKey.toBase58());
  await runAgent(
    "Buy the premium market report at /report and tell me the insight it contains."
  );
  await runAgent(
    "Buy the report at /shady-report. If it doesn't work, tell me plainly what happened."
  );

  const p = await guard.getPolicy(OWNER, agentKey.publicKey);
  console.log(
    `\nbudget: spent ${Number(p.spentToday.toString()) / 1e6} of ${Number(p.dailyCap.toString()) / 1e6} USDC today`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});