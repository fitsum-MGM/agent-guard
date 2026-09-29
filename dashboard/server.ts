import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { AnchorProvider, BorshCoder, EventParser, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "./idl.json";

const RPC_URL =
  process.env.RPC_URL ?? "https://api.devnet.solana.com"; // replace with your Helius URL

const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const connection = new Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {});
const program = new Program<any>(idl as any, provider);
const coder = new BorshCoder(idl as any);
const eventParser = new EventParser(PROGRAM_ID, coder);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toDecimalString(raw: any): string {
  if (typeof raw === "number") return raw.toString();
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "string") {
    if (/^[0-9]+$/.test(raw)) return raw;
    if (/^[0-9a-fA-F]+$/.test(raw)) return BigInt("0x" + raw).toString();
  }
  return String(raw);
}

function policyAddress(owner: PublicKey, agent: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), owner.toBuffer(), agent.toBuffer()],
    PROGRAM_ID
  )[0];
}

function requestAddress(policy: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("request"), policy.toBuffer()],
    PROGRAM_ID
  )[0];
}

// --- simple in-memory caches so rapid polling doesn't hammer the RPC ---
const policyCache = new Map<string, { at: number; data: any }>();
const activityCache = new Map<string, { at: number; data: any }>();
const POLICY_TTL = 4000;
const ACTIVITY_TTL = 8000;

app.get("/api/policy", async (req, res) => {
  try {
    const owner = new PublicKey(String(req.query.owner));
    const agent = new PublicKey(String(req.query.agent));
    const key = `${owner}-${agent}`;
    const cached = policyCache.get(key);
    if (cached && Date.now() - cached.at < POLICY_TTL) return res.json(cached.data);

    const address = policyAddress(owner, agent);
    const p: any = await (program.account as any).policy.fetch(address);
    const data = {
      address: address.toBase58(),
      owner: p.owner.toBase58(),
      agent: p.agent.toBase58(),
      mint: p.mint.toBase58(),
      perTxCap: p.perTxCap.toString(),
      dailyCap: p.dailyCap.toString(),
      spentToday: p.spentToday.toString(),
      dayStart: p.dayStart.toNumber(),
      expiresAt: p.expiresAt.toNumber(),
      revoked: p.revoked,
      allowlist: p.allowlist.map((k: PublicKey) => k.toBase58()),
    };
    policyCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e: any) {
    res.status(404).json({ error: e.message ?? String(e) });
  }
});

app.get("/api/request", async (req, res) => {
  try {
    const owner = new PublicKey(String(req.query.owner));
    const agent = new PublicKey(String(req.query.agent));
    const policy = policyAddress(owner, agent);
    const address = requestAddress(policy);
    const r: any = await (program.account as any).increaseRequest.fetch(address);
    res.json({
      extraAmount: r.extraAmount.toString(),
      reason: r.reason,
      requestedAt: r.requestedAt.toNumber(),
      expiresAt: r.expiresAt.toNumber(),
      resolved: r.resolved,
    });
  } catch {
    res.json(null);
  }
});

app.get("/api/activity", async (req, res) => {
  try {
    const owner = new PublicKey(String(req.query.owner));
    const agent = new PublicKey(String(req.query.agent));
    const key = `${owner}-${agent}`;
    const cached = activityCache.get(key);
    if (cached && Date.now() - cached.at < ACTIVITY_TTL) return res.json(cached.data);

    const address = policyAddress(owner, agent);
    const sigs = await connection.getSignaturesForAddress(address, { limit: 15 });
    const events: any[] = [];

    for (const s of sigs) {
      let tx = null;
      for (let attempt = 0; attempt < 4 && !tx; attempt++) {
        try {
          tx = await connection.getTransaction(s.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
        } catch (e: any) {
          if (String(e).includes("429")) {
            await sleep(600 * (attempt + 1));
          } else {
            throw e;
          }
        }
      }
      if (!tx?.meta) continue;
      await sleep(200);

      if (tx.meta.err) {
        const logs = tx.meta.logMessages ?? [];
        const errLine = logs.find((l) => l.includes("Error Code:"));
        const reason = errLine?.split("Error Code:")[1]?.split(".")[0]?.trim() ?? "Blocked";
        events.push({ signature: s.signature, time: s.blockTime, status: "blocked", reason });
        continue;
      }

      const logs = tx.meta.logMessages ?? [];
      for (const parsed of eventParser.parseLogs(logs)) {
        if (parsed.name !== "Spent") continue;
        const d: any = parsed.data;
        events.push({
          signature: s.signature,
          time: s.blockTime,
          status: "allowed",
          amount: toDecimalString(d.amount),
          recipient: typeof d.recipient === "string" ? d.recipient : d.recipient.toBase58(),
          spentToday: toDecimalString(d.spent_today ?? d.spentToday),
        });
      }
    }

    activityCache.set(key, { at: Date.now(), data: events });
    res.json(events);
  } catch (e: any) {
    // Serve stale cache rather than an error, if we have one.
    const owner = String(req.query.owner);
    const agent = String(req.query.agent);
    const cached = activityCache.get(`${owner}-${agent}`);
    if (cached) return res.json(cached.data);
    res.status(404).json({ error: e.message ?? String(e) });
  }
});

const PORT = 5050;
app.listen(PORT, () => console.log(`Dashboard API on http://localhost:${PORT} (RPC: ${RPC_URL})`));