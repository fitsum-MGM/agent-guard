import fs from "fs";
import os from "os";
import path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import { AgentGuard, explain } from "../src";

const USDC = 1_000_000n; // 6 decimals

const loadKeypair = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

function loadOrCreate(name: string): Keypair {
  const dir = path.join(__dirname, "..", ".keys");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function attempt(label: string, fn: () => Promise<string>) {
  try {
    const sig = await fn();
    console.log(`✅ ${label} -> allowed (${sig.slice(0, 12)}...)`);
  } catch (e) {
    console.log(`⛔ ${label} -> blocked: ${explain(e)}`);
  }
}

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const owner = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const agent = loadOrCreate("agent");
  const merchant = loadOrCreate("merchant");
  const stranger = loadOrCreate("stranger");
  const mintKp = loadOrCreate("mint");
  const mint = mintKp.publicKey;

  console.log("owner   :", owner.publicKey.toBase58());
  console.log("agent   :", agent.publicKey.toBase58());
  console.log("merchant:", merchant.publicKey.toBase58());
  console.log("mint    :", mint.toBase58());

  // The agent needs a little SOL for transaction fees.
  if ((await connection.getBalance(agent.publicKey)) < 20_000_000) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: agent.publicKey,
          lamports: 50_000_000,
        })
      ),
      [owner]
    );
  }

  // Test USDC mint (our own, since devnet USDC needs a faucet).
  if (!(await connection.getAccountInfo(mint))) {
    await createMint(connection, owner, owner.publicKey, null, 6, mintKp);
  }

  const ata = async (wallet: PublicKey) =>
    (await getOrCreateAssociatedTokenAccount(connection, owner, mint, wallet)).address;
  const ownerAta = await ata(owner.publicKey);
  await ata(merchant.publicKey);
  await ata(stranger.publicKey);

  if ((await getAccount(connection, ownerAta)).amount < 500n * USDC) {
    await mintTo(connection, owner, mint, ownerAta, owner, 1000n * USDC);
  }

  // Create the policy once: 100 per tx, 250 per day, only `merchant`, valid 7 days.
  const ownerGuard = new AgentGuard(connection, owner);
  try {
    await ownerGuard.getPolicy(owner.publicKey, agent.publicKey);
  } catch {
    const { signature } = await ownerGuard.createPolicy({
      agent: agent.publicKey,
      mint,
      perTxCap: 100n * USDC,
      dailyCap: 250n * USDC,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
      allowlist: [merchant.publicKey],
    });
    console.log("policy created:", signature.slice(0, 12) + "...");
  }

  // Make sure the vault holds some USDC.
  const policyAddr = AgentGuard.policyAddress(owner.publicKey, agent.publicKey);
  const vault = AgentGuard.vaultAddress(policyAddr, mint);
  if ((await getAccount(connection, vault)).amount < 300n * USDC) {
    await transfer(connection, owner, ownerAta, vault, owner, 500n * USDC);
  }

  console.log("\n--- The agent tries to spend ---");
  const agentGuard = new AgentGuard(connection, agent);
  const spend = (to: PublicKey, amount: bigint) => () =>
    agentGuard.spend({ owner: owner.publicKey, mint, recipient: to, amount });

  await attempt("pay merchant 40 USDC (within limits)", spend(merchant.publicKey, 40n * USDC));
  await attempt("pay merchant 150 USDC (over per-tx cap)", spend(merchant.publicKey, 150n * USDC));
  await attempt("pay stranger 10 USDC (not allowlisted)", spend(stranger.publicKey, 10n * USDC));

  console.log("\n--- The owner revokes the agent ---");
  await ownerGuard.setRevoked(agent.publicKey, true);
  await attempt("pay merchant 10 USDC (after revoke)", spend(merchant.publicKey, 10n * USDC));
  await ownerGuard.setRevoked(agent.publicKey, false); // leave the demo reusable

  const p = await ownerGuard.getPolicy(owner.publicKey, agent.publicKey);
  console.log("\nspent today :", Number(p.spentToday.toString()) / 1e6, "USDC");
  console.log("vault       :", Number((await getAccount(connection, vault)).amount) / 1e6, "USDC");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});