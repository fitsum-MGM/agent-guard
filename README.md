# 🛡️ Agent Guard

**On-chain spending controls for AI agents on Solana — with a feature no other agent wallet has: agents can ask for more, owners approve from anywhere.**

## The problem

AI agents are starting to pay for things on their own — APIs, data, services. Giving an agent a wallet with no limits means one bad prompt, one compromised key, or one bug can drain it. Every option today is a blunt hammer: either the agent has no budget at all, or it hits a hard cap and the task just dies.

## What Agent Guard does

An owner funds a prepaid USDC vault and sets rules enforced by an on-chain Anchor program — not a backend, not a trusted server:

- **Per-transaction cap** — no single payment can be too large.
- **Daily cap** — bounds total exposure even across many small payments.
- **Recipient allowlist** — the agent can only pay wallets the owner approved.
- **Expiry** — the policy self-disables after a set date.
- **Instant revoke** — the owner can cut off the agent at any time.
- **Escalation requests** *(new)* — when an agent legitimately needs more budget mid-task, it can request an increase with a reason. The owner approves or denies on-chain, from a phone, without editing scripts or config. This is the piece every other agent-wallet product we found is missing: they all hard-reject and give up.

If a compromised or misled agent tries to overspend or pay the wrong address, the **Solana runtime itself** rejects it — no application-layer trust required.

## Why now

Solana shipped native Subscriptions & Allowances for capped agent spending on Sept 4, 2026. Several agent-wallet products (Openfort, DCP, Crossmint, onchain-agent-wallets) already enforce caps on-chain. Spending caps are becoming table stakes. What's missing across all of them is a graceful way to *ask for more* — Agent Guard's escalation flow closes that gap.

## Architecture

Owner ──funds──> Vault (USDC ATA, owned by the Policy PDA)
│
Agent ──spend()──────>│── checks: revoked? expired? per-tx cap? daily cap? allowlisted? ──> pays recipient
│
Agent ──request_increase()──> IncreaseRequest PDA ──respond_to_request()── Owner


- **Program:** Anchor 1.x, deployed to Solana devnet: `7HGd3guukPCe4atyc72Z4Uy7hs6r5KzbUFsmxxRTHC9W`
- **SDK:** TypeScript client in `sdk/`
- **Demo agent:** a real Claude-powered agent (`sdk/examples/llm-agent.ts`) that decides on its own to call a paywalled endpoint, using the SDK to pay
- **Dashboard:** live budget, activity feed, and pending-request banner (`dashboard/`)

## What's tested

14 automated tests (LiteSVM) covering every rule and every rejection path: over-cap spends, non-allowlisted recipients, wrong signer, revoked/expired policies, and the full escalation flow (request → approve → raised cap enforced; request → deny → cap unchanged). Run with `anchor test`.

## Try it

```bash
# 1. Program
anchor build && anchor test

# 2. SDK demo (devnet)
cd sdk && npm install && npm run demo

# 3. Paywall + agent buying a report, blocked from a shady one
npm run server   # separate terminal
npm run agent

# 4. Dashboard
cd ../dashboard && npm install && npm run dev
# open http://localhost:5050
```

## What's next

- Align the paywall flow with the emerging x402 standard rather than our simplified version
- Multi-agent policies and per-recipient sub-limits
- Mainnet deployment with a security audit
- Native integration with agent frameworks (LangChain, MCP)

## Team

Fitsum — solo builder.