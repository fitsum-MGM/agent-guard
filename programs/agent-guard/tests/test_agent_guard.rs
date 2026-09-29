use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const START_TIME: i64 = 1_000_000;
const USDC: u64 = 1_000_000; // 6 decimals

fn token_program() -> Pubkey {
    anchor_spl::token::ID
}

fn ata(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program().as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    )
    .0
}

fn mint_data(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = decimals; // decimals
    d[45] = 1; // is_initialized
    d
}

fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state = Initialized
    d
}

fn put(svm: &mut LiteSVM, key: Pubkey, data: Vec<u8>, owner: Pubkey) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        key,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = ts;
    svm.set_sysvar::<Clock>(&clock);
}

struct Ctx {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    stranger: Keypair,
    merchant: Keypair,
    mint: Pubkey,
    policy: Pubkey,
    vault: Pubkey,
    merchant_ata: Pubkey,
    stranger_ata: Pubkey,
    owner_ata: Pubkey,
}

impl Ctx {
    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &blockhash);
        let tx =
            VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash(); // lets us send identical transactions again
        match res {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("{:?}", e)),
        }
    }

    fn balance(&self, key: &Pubkey) -> u64 {
        let a = self.svm.get_account(key).unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    fn spend_ix(&self, signer: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            agent_guard::id(),
            &agent_guard::instruction::Spend { amount }.data(),
            agent_guard::accounts::Spend {
                agent: *signer,
                policy: self.policy,
                mint: self.mint,
                vault: self.vault,
                recipient_token_account: *to,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }

    fn revoke_ix(&self, signer: &Pubkey, revoked: bool) -> Instruction {
        Instruction::new_with_bytes(
            agent_guard::id(),
            &agent_guard::instruction::SetRevoked { revoked }.data(),
            agent_guard::accounts::OwnerOnly {
                owner: *signer,
                policy: self.policy,
            }
            .to_account_metas(None),
        )
    }

    fn withdraw_ix(&self, signer: &Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            agent_guard::id(),
            &agent_guard::instruction::Withdraw { amount }.data(),
            agent_guard::accounts::Withdraw {
                owner: *signer,
                policy: self.policy,
                mint: self.mint,
                vault: self.vault,
                owner_token_account: self.owner_ata,
                token_program: token_program(),
            }
            .to_account_metas(None),
        )
    }
        fn request_increase_ix(
        &self,
        signer: &Pubkey,
        extra_amount: u64,
        reason: &str,
        valid_for_secs: i64,
    ) -> Instruction {
        let request = Pubkey::find_program_address(
            &[b"request", self.policy.as_ref()],
            &agent_guard::id(),
        )
        .0;
        Instruction::new_with_bytes(
            agent_guard::id(),
            &agent_guard::instruction::RequestIncrease {
                extra_amount,
                reason: reason.to_string(),
                valid_for_secs,
            }
            .data(),
            agent_guard::accounts::RequestIncrease {
                agent: *signer,
                policy: self.policy,
                request,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn respond_ix(&self, signer: &Pubkey, approve: bool) -> Instruction {
        let request = Pubkey::find_program_address(
            &[b"request", self.policy.as_ref()],
            &agent_guard::id(),
        )
        .0;
        Instruction::new_with_bytes(
            agent_guard::id(),
            &agent_guard::instruction::RespondToRequest { approve }.data(),
            agent_guard::accounts::RespondToRequest {
                owner: *signer,
                policy: self.policy,
                request,
            }
            .to_account_metas(None),
        )
    }
}

/// Policy: per-tx cap 100 USDC, daily cap 250 USDC, only `merchant` is allowed,
/// vault funded with 500 USDC, expires one hour after START_TIME.
fn setup() -> Ctx {
    let program_id = agent_guard::id();
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/agent_guard.so"
    ));
    svm.add_program(program_id, bytes).unwrap();
    set_time(&mut svm, START_TIME);

    let owner = Keypair::new();
    let agent = Keypair::new();
    let stranger = Keypair::new();
    let merchant = Keypair::new();
    for k in [&owner, &agent, &stranger] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }

    let mint = Keypair::new().pubkey();
    put(&mut svm, mint, mint_data(6), token_program());

    let merchant_ata = ata(&merchant.pubkey(), &mint);
    let stranger_ata = ata(&stranger.pubkey(), &mint);
    let owner_ata = ata(&owner.pubkey(), &mint);
    put(&mut svm, merchant_ata, token_account_data(&mint, &merchant.pubkey(), 0), token_program());
    put(&mut svm, stranger_ata, token_account_data(&mint, &stranger.pubkey(), 0), token_program());
    put(&mut svm, owner_ata, token_account_data(&mint, &owner.pubkey(), 0), token_program());

    let policy = Pubkey::find_program_address(
        &[b"policy", owner.pubkey().as_ref(), agent.pubkey().as_ref()],
        &program_id,
    )
    .0;
    let vault = ata(&policy, &mint);

    let mut ctx = Ctx {
        svm,
        owner,
        agent,
        stranger,
        merchant,
        mint,
        policy,
        vault,
        merchant_ata,
        stranger_ata,
        owner_ata,
    };

    let create = Instruction::new_with_bytes(
        program_id,
        &agent_guard::instruction::CreatePolicy {
            per_tx_cap: 100 * USDC,
            daily_cap: 250 * USDC,
            expires_at: START_TIME + 3600,
            allowlist: vec![ctx.merchant.pubkey()],
        }
        .data(),
        agent_guard::accounts::CreatePolicy {
            owner: ctx.owner.pubkey(),
            agent: ctx.agent.pubkey(),
            mint,
            policy,
            vault,
            token_program: token_program(),
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    ctx.send(create, &owner).expect("create_policy should succeed");

    // Fund the vault with 500 USDC by writing its balance directly.
    let mut acct = ctx.svm.get_account(&vault).unwrap();
    acct.data[64..72].copy_from_slice(&(500 * USDC).to_le_bytes());
    ctx.svm.set_account(vault, acct).unwrap();
    ctx
}

fn assert_err(res: Result<(), String>, code: &str) {
    let e = res.expect_err("transaction should have been rejected");
    assert!(e.contains(code), "expected {code}, got: {e}");
}

fn agent_key(ctx: &Ctx) -> Keypair {
    Keypair::try_from(ctx.agent.to_bytes().as_slice()).unwrap()
}

#[test]
fn agent_can_pay_allowlisted_recipient() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 50 * USDC);
    ctx.send(ix, &agent).expect("spend should succeed");
    assert_eq!(ctx.balance(&ctx.merchant_ata), 50 * USDC);
    assert_eq!(ctx.balance(&ctx.vault), 450 * USDC);
}

#[test]
fn blocks_amount_over_per_tx_cap() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC + 1);
    assert_err(ctx.send(ix, &agent), "ExceedsPerTxCap");
}

#[test]
fn blocks_recipient_not_on_allowlist() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.stranger_ata, 10 * USDC);
    assert_err(ctx.send(ix, &agent), "RecipientNotAllowed");
}

#[test]
fn blocks_spending_over_daily_cap() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    for _ in 0..2 {
        let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
        ctx.send(ix, &agent).expect("first two spends fit under the daily cap");
    }
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
    assert_err(ctx.send(ix, &agent), "ExceedsDailyCap");
    assert_eq!(ctx.balance(&ctx.merchant_ata), 200 * USDC);
}

#[test]
fn blocks_wrong_signer() {
    let mut ctx = setup();
    let stranger = Keypair::try_from(ctx.stranger.to_bytes().as_slice()).unwrap();
    let ix = ctx.spend_ix(&stranger.pubkey(), &ctx.merchant_ata, 10 * USDC);
    assert_err(ctx.send(ix, &stranger), "NotAgent");
}

#[test]
fn blocks_spending_after_revoke() {
    let mut ctx = setup();
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    let agent = agent_key(&ctx);
    let revoke = ctx.revoke_ix(&owner.pubkey(), true);
    ctx.send(revoke, &owner).expect("owner can revoke");
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 10 * USDC);
    assert_err(ctx.send(ix, &agent), "Revoked");
}

#[test]
fn blocks_spending_after_expiry() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    set_time(&mut ctx.svm, START_TIME + 7200);
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 10 * USDC);
    assert_err(ctx.send(ix, &agent), "Expired");
}

#[test]
fn owner_can_withdraw_after_revoke() {
    let mut ctx = setup();
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    let revoke = ctx.revoke_ix(&owner.pubkey(), true);
    ctx.send(revoke, &owner).unwrap();
    let ix = ctx.withdraw_ix(&owner.pubkey(), 500 * USDC);
    ctx.send(ix, &owner).expect("owner can always withdraw");
    assert_eq!(ctx.balance(&ctx.owner_ata), 500 * USDC);
    assert_eq!(ctx.balance(&ctx.vault), 0);
}

#[test]
fn non_owner_cannot_revoke() {
    let mut ctx = setup();
    let stranger = Keypair::try_from(ctx.stranger.to_bytes().as_slice()).unwrap();
    let ix = ctx.revoke_ix(&stranger.pubkey(), true);
    assert_err(ctx.send(ix, &stranger), "NotOwner");
}

#[test]
fn owner_can_approve_increase_request() {
    let mut ctx = setup();
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    let agent = agent_key(&ctx);

    let req = ctx.request_increase_ix(&agent.pubkey(), 100 * USDC, "need more for a big task", 3600);
    ctx.send(req, &agent).expect("agent can request an increase");

    let respond = ctx.respond_ix(&owner.pubkey(), true);
    ctx.send(respond, &owner).expect("owner can approve");

    // Daily cap was 250 USDC; approval should raise it to 350.
    // Spend 300 total to prove the raised cap is actually enforced on-chain.
    let ix1 = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
    ctx.send(ix1, &agent).expect("first 100 fits under either cap");
    let ix2 = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
    ctx.send(ix2, &agent).expect("second 100 fits under either cap");
    let ix3 = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
    ctx.send(ix3, &agent)
        .expect("third 100 only fits because the cap was raised to 350");

    let ix4 = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 60 * USDC);
    assert_err(ctx.send(ix4, &agent), "ExceedsDailyCap");
}

#[test]
fn denied_request_does_not_raise_cap() {
    let mut ctx = setup();
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    let agent = agent_key(&ctx);

    let req = ctx.request_increase_ix(&agent.pubkey(), 100 * USDC, "please", 3600);
    ctx.send(req, &agent).unwrap();
    let respond = ctx.respond_ix(&owner.pubkey(), false);
    ctx.send(respond, &owner).expect("owner can deny");

    // Original 250 daily cap should still be enforced.
    for _ in 0..2 {
        let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
        ctx.send(ix, &agent).unwrap();
    }
    let ix = ctx.spend_ix(&agent.pubkey(), &ctx.merchant_ata, 100 * USDC);
    assert_err(ctx.send(ix, &agent), "ExceedsDailyCap");
}

#[test]
fn cannot_respond_twice_to_same_request() {
    let mut ctx = setup();
    let owner = Keypair::try_from(ctx.owner.to_bytes().as_slice()).unwrap();
    let agent = agent_key(&ctx);

    let req = ctx.request_increase_ix(&agent.pubkey(), 50 * USDC, "reason", 3600);
    ctx.send(req, &agent).unwrap();
    let respond1 = ctx.respond_ix(&owner.pubkey(), true);
    ctx.send(respond1, &owner).expect("first response succeeds");

    let respond2 = ctx.respond_ix(&owner.pubkey(), true);
    assert_err(ctx.send(respond2, &owner), "RequestAlreadyResolved");
}

#[test]
fn stranger_cannot_request_on_behalf_of_agent() {
    let mut ctx = setup();
    let stranger = Keypair::try_from(ctx.stranger.to_bytes().as_slice()).unwrap();
    let req = ctx.request_increase_ix(&stranger.pubkey(), 50 * USDC, "reason", 3600);
    assert_err(ctx.send(req, &stranger), "NotAgent");
}

#[test]
fn stranger_cannot_approve_request() {
    let mut ctx = setup();
    let agent = agent_key(&ctx);
    let stranger = Keypair::try_from(ctx.stranger.to_bytes().as_slice()).unwrap();

    let req = ctx.request_increase_ix(&agent.pubkey(), 50 * USDC, "reason", 3600);
    ctx.send(req, &agent).unwrap();

    let respond = ctx.respond_ix(&stranger.pubkey(), true);
    assert_err(ctx.send(respond, &stranger), "NotOwner");
}