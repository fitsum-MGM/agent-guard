import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AgentGuard, explain } from "../src";
import { loadOrCreate } from "./keys";

// Public key of the policy owner (the agent never sees the owner's secret key).
const OWNER = new PublicKey(
  process.env.OWNER ?? "FCG1cUinpSRdp7Wp5xU1evdMm6us8m5KZHAmdwyy7ppw"
);
const BASE = process.env.BASE_URL ?? "http://localhost:4021";

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const agent = loadOrCreate("agent");
const guard = new AgentGuard(connection, agent);

/** The x402-style flow: request, get a 402 quote, pay through Agent Guard, retry with proof. */
async function payAndFetch(path: string) {
  const url = BASE + path;
  const first = await fetch(url);
  if (first.status !== 402) return first;

  const quote: any = await first.json();
  console.log(`   server wants ${Number(quote.amount) / 10 ** quote.decimals} USDC -> ${quote.payTo}`);

  const signature = await guard.spend({
    owner: OWNER,
    mint: new PublicKey(quote.mint),
    recipient: new PublicKey(quote.payTo),
    amount: BigInt(quote.amount),
  });
  console.log(`   paid, signature ${signature.slice(0, 12)}...`);
  return fetch(url, { headers: { "X-Payment": signature } });
}

async function tryBuy(label: string, path: string) {
  console.log(`\n> ${label}`);
  try {
    const res = await payAndFetch(path);
    console.log(`✅ got data (${res.status}):`, JSON.stringify(await res.json()));
  } catch (e) {
    console.log(`⛔ payment blocked by Agent Guard: ${explain(e)}`);
  }
}

async function main() {
  console.log("agent:", agent.publicKey.toBase58());
  await tryBuy("Buy the legit report", "/report");
  await tryBuy("Buy the shady report (pays a wallet that is not allowlisted)", "/shady-report");

  const p = await guard.getPolicy(OWNER, agent.publicKey);
  console.log(
    `\nbudget: spent ${Number(p.spentToday.toString()) / 1e6} of ${Number(p.dailyCap.toString()) / 1e6} USDC today`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});