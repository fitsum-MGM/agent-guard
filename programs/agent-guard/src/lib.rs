use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("7HGd3guukPCe4atyc72Z4Uy7hs6r5KzbUFsmxxRTHC9W");

pub const MAX_ALLOWLIST: usize = 8;

#[program]
pub mod agent_guard {
    use super::*;

    pub fn create_policy(
        ctx: Context<CreatePolicy>,
        per_tx_cap: u64,
        daily_cap: u64,
        expires_at: i64,
        allowlist: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            per_tx_cap > 0 && per_tx_cap <= daily_cap,
            GuardError::InvalidCaps
        );
        require!(allowlist.len() <= MAX_ALLOWLIST, GuardError::AllowlistTooLong);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, GuardError::InvalidExpiry);

        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.agent = ctx.accounts.agent.key();
        policy.mint = ctx.accounts.mint.key();
        policy.per_tx_cap = per_tx_cap;
        policy.daily_cap = daily_cap;
        policy.spent_today = 0;
        policy.day_start = now;
        policy.expires_at = expires_at;
        policy.revoked = false;
        policy.allowlist = allowlist;
        policy.bump = ctx.bumps.policy;
        Ok(())
    }

    pub fn set_revoked(ctx: Context<SetRevoked>, revoked: bool) -> Result<()> {
        ctx.accounts.policy.revoked = revoked;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub per_tx_cap: u64,
    pub daily_cap: u64,
    pub spent_today: u64,
    pub day_start: i64,
    pub expires_at: i64,
    pub revoked: bool,
    #[max_len(8)]
    pub allowlist: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreatePolicy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: only the agent's public key is stored; it does not sign here.
    pub agent: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + Policy::INIT_SPACE,
        seeds = [b"policy", owner.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRevoked<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ GuardError::NotOwner)]
    pub policy: Account<'info, Policy>,
}

#[error_code]
pub enum GuardError {
    #[msg("Caps must be positive and per-tx cap must not exceed the daily cap")]
    InvalidCaps,
    #[msg("Allowlist is too long")]
    AllowlistTooLong,
    #[msg("Expiry must be in the future")]
    InvalidExpiry,
    #[msg("Only the policy owner can do this")]
    NotOwner,
}