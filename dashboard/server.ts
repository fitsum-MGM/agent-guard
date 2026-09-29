import express from "express";
import cors from "cors";
import path from "path";
import { AnchorProvider, BorshCoder, EventParser, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import idl from "./idl.json";

const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {});
const program = new Program<any>(idl as any, provider);
const coder = new BorshCoder(idl as any);
const eventParser = new EventParser(PROGRAM_ID, coder);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

function policyAddress(owner: PublicKey, agent: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), owner.toBuffer(), agent.toBuffer()],
    PROGRAM_ID
  )[0];
}

// GET /api/policy?owner=...&agent=...
app.get("/api/policy", async (req, res) => {
  try {
    const owner = new PublicKey(String(req.query.owner));
    const agent = new PublicKey(String(req.query.agent));
    const address = policyAddress(owner, agent);
    const p: any = await (program.account as any).policy.fetch(address);
    res.json({
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
    });
  } catch (e: any) {
    res.status(404).json({ error: e.message ?? String(e) });
  }
});

// GET /api/activity?owner=...&agent=...  -> recent allowed (Spent) and blocked attempts
app.get("/api/activity", async (req, res) => {
  try {
    const owner = new PublicKey(String(req.query.owner));
    const agent = new PublicKey(String(req.query.agent));
    const address = policyAddress(owner, agent);

    const sigs = await connection.getSignaturesForAddress(address, { limit: 25 });
    const events: any[] = [];

    for (const s of sigs) {
      const tx = await connection.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;

      if (tx.meta.err) {
        const logs = tx.meta.logMessages ?? [];
        const errLine = logs.find((l) => l.includes("Error Code:"));
        const reason = errLine?.split("Error Code:")[1]?.split(".")[0]?.trim() ?? "Blocked";
        events.push({
          signature: s.signature,
          time: s.blockTime,
          status: "blocked",
          reason,
        });
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
          amount: d.amount.toString(),
          recipient: d.recipient.toBase58(),
          spentToday: d.spentToday.toString(),
        });
      }
    }

    res.json(events);
  } catch (e: any) {
    res.status(404).json({ error: e.message ?? String(e) });
  }
});

const PORT = 5050;
app.listen(PORT, () => console.log(`Dashboard API on http://localhost:${PORT}`));