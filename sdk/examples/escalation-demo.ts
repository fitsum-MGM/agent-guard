import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { AgentGuard, explain } from "../src";
import { loadOrCreate, loadKeypair } from "./keys";
import path from "path";
import os from "os";

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const owner = loadKeypair(path.join(os.homedir(), ".config/solana/id.json"));
  const agent = loadOrCreate("agent");

  const agentGuard = new AgentGuard(connection, agent);
  const ownerGuard = new AgentGuard(connection, owner);

  console.log("Agent requesting +30 USDC...");
  const sig = await agentGuard.requestIncrease({
    owner: owner.publicKey,
    extraAmount: 30_000_000n,
    reason: "Ran out of budget mid-task, need to finish the report.",
    validForSecs: 3600,
  });
  console.log("requested:", sig.slice(0, 12) + "...");

  const req = await agentGuard.getRequest(owner.publicKey, agent.publicKey);
  console.log("pending request:", req);

  console.log("\nOwner approving...");
  const sig2 = await ownerGuard.respondToRequest(agent.publicKey, true);
  console.log("approved:", sig2.slice(0, 12) + "...");

  const policy = await ownerGuard.getPolicy(owner.publicKey, agent.publicKey);
  console.log("new daily cap:", Number(policy.dailyCap.toString()) / 1e6, "USDC");
}

main().catch((e) => console.error(explain(e)));