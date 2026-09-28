import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./idl.json";

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);

const toBN = (v: bigint | number) => new BN(v.toString());

export interface PolicyAccount {
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  perTxCap: BN;
  dailyCap: BN;
  spentToday: BN;
  dayStart: BN;
  expiresAt: BN;
  revoked: boolean;
  allowlist: PublicKey[];
  bump: number;
}

/** Turns an Anchor error into a readable "ErrorName: message" string. */
export function explain(e: any): string {
  const code = e?.error?.errorCode?.code;
  const msg = e?.error?.errorMessage ?? e?.message ?? String(e);
  return code ? `${code}: ${msg}` : msg;
}

export class AgentGuard {
  readonly program: Program<any>;

  /** `signer` is the owner for owner actions, or the agent for `spend`. */
  constructor(readonly connection: Connection, readonly signer: Keypair) {
    const provider = new AnchorProvider(connection, new Wallet(signer), {
      commitment: "confirmed",
    });
    this.program = new Program<any>(idl as any, provider);
  }

  private get m(): any {
    return this.program.methods;
  }

  static policyAddress(owner: PublicKey, agent: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("policy"), owner.toBuffer(), agent.toBuffer()],
      PROGRAM_ID
    )[0];
  }

  static vaultAddress(policy: PublicKey, mint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, policy, true);
  }

  async getPolicy(owner: PublicKey, agent: PublicKey): Promise<PolicyAccount> {
    const address = AgentGuard.policyAddress(owner, agent);
    return (this.program.account as any).policy.fetch(address);
  }

  /** Owner: create a budget policy and its vault. */
  async createPolicy(p: {
    agent: PublicKey;
    mint: PublicKey;
    perTxCap: bigint;
    dailyCap: bigint;
    expiresAt: number; // unix seconds
    allowlist: PublicKey[]; // recipient wallet addresses
  }) {
    const owner = this.signer.publicKey;
    const policy = AgentGuard.policyAddress(owner, p.agent);
    const vault = AgentGuard.vaultAddress(policy, p.mint);
    const signature: string = await this.m
      .createPolicy(toBN(p.perTxCap), toBN(p.dailyCap), toBN(p.expiresAt), p.allowlist)
      .accounts({
        owner,
        agent: p.agent,
        mint: p.mint,
        policy,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { signature, policy, vault };
  }

  /** Owner: instantly block (or unblock) the agent. */
  async setRevoked(agent: PublicKey, revoked: boolean): Promise<string> {
    const owner = this.signer.publicKey;
    return this.m
      .setRevoked(revoked)
      .accounts({ owner, policy: AgentGuard.policyAddress(owner, agent) })
      .rpc();
  }

  /** Owner: replace the list of allowed recipient wallets. */
  async setAllowlist(agent: PublicKey, allowlist: PublicKey[]): Promise<string> {
    const owner = this.signer.publicKey;
    return this.m
      .setAllowlist(allowlist)
      .accounts({ owner, policy: AgentGuard.policyAddress(owner, agent) })
      .rpc();
  }

  /** Owner: take unspent funds back out of the vault. */
  async withdraw(agent: PublicKey, mint: PublicKey, amount: bigint): Promise<string> {
    const owner = this.signer.publicKey;
    const policy = AgentGuard.policyAddress(owner, agent);
    return this.m
      .withdraw(toBN(amount))
      .accounts({
        owner,
        policy,
        mint,
        vault: AgentGuard.vaultAddress(policy, mint),
        ownerTokenAccount: getAssociatedTokenAddressSync(mint, owner),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /** Agent: pay `recipient` (a wallet address) if every rule allows it. */
  async spend(p: {
    owner: PublicKey;
    mint: PublicKey;
    recipient: PublicKey;
    amount: bigint;
  }): Promise<string> {
    const agent = this.signer.publicKey;
    const policy = AgentGuard.policyAddress(p.owner, agent);
    return this.m
      .spend(toBN(p.amount))
      .accounts({
        agent,
        policy,
        mint: p.mint,
        vault: AgentGuard.vaultAddress(policy, p.mint),
        recipientTokenAccount: getAssociatedTokenAddressSync(p.mint, p.recipient),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }
}