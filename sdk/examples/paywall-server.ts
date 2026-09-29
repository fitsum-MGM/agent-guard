import http from "http";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { loadOrCreate } from "./keys";

const USDC = 1_000_000n;
const PRICE = 5n * USDC;
const PORT = 4021;

const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const merchant = loadOrCreate("merchant").publicKey; // on the allowlist
const shady = loadOrCreate("stranger").publicKey; // NOT on the allowlist
const mint = loadOrCreate("mint").publicKey;

const used = new Set<string>(); // replay protection (in memory, demo only)

const routes: Record<string, { payTo: PublicKey; body: unknown }> = {
  "/report": {
    payTo: merchant,
    body: { title: "Premium market report (demo data)", insight: "Stablecoin volume on Solana keeps growing." },
  },
  "/shady-report": {
    payTo: shady,
    body: { title: "Shady report", insight: "You should never see this." },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns null if the payment is valid, or a reason string if not. */
async function verifyPayment(sig: string, payTo: PublicKey, amount: bigint): Promise<string | null> {
  if (used.has(sig)) return "payment already used";
  let tx = null;
  for (let i = 0; i < 5 && !tx; i++) {
    tx = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) await sleep(1000);
  }
  if (!tx || !tx.meta || tx.meta.err) return "transaction not found or failed";

  const find = (list: any[] | null | undefined) =>
    list?.find((b) => b.owner === payTo.toBase58() && b.mint === mint.toBase58());
  const pre = BigInt(find(tx.meta.preTokenBalances)?.uiTokenAmount.amount ?? "0");
  const post = BigInt(find(tx.meta.postTokenBalances)?.uiTokenAmount.amount ?? "0");
  if (post - pre < amount) return "payment too small or sent to the wrong wallet";

  used.add(sig);
  return null;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const route = routes[req.url ?? ""];
    if (!route) return send(res, 404, { error: "not found" });

    const proof = req.headers["x-payment"];
    if (typeof proof !== "string") {
      return send(res, 402, {
        scheme: "solana-spl-exact",
        network: "solana-devnet",
        mint: mint.toBase58(),
        payTo: route.payTo.toBase58(),
        amount: PRICE.toString(),
        decimals: 6,
        description: "Pay with the signature of an SPL token transfer, then retry with X-Payment.",
      });
    }
    const problem = await verifyPayment(proof, route.payTo, PRICE);
    if (problem) return send(res, 402, { error: problem });
    send(res, 200, route.body);
  })
  .listen(PORT, () => console.log(`Paywall server on http://localhost:${PORT}  (try /report and /shady-report)`));