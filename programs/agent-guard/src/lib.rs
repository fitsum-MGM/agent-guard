use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("7HGd3guukPCe4atyc72Z4Uy7hs6r5KzbUFsmxxRTHC9W");

pub const MAX_ALLOWLIST: usize = 8;
pub const SECONDS_PER_DAY: i64 = 86_400;

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

    pub fn set_revoked(ctx: Context<OwnerOnly>, revoked: bool) -> Result<()> {
        ctx.accounts.policy.revoked = revoked;
        Ok(())
    }

    pub fn set_allowlist(ctx: Context<OwnerOnly>, allowlist: Vec<Pubkey>) -> Result<()> {
        require!(allowlist.len() <= MAX_ALLOWLIST, GuardError::AllowlistTooLong);
        ctx.accounts.policy.allowlist = allowlist;
        Ok(())
    }

    pub fn spend(ctx: Context<Spend>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let recipient_owner = ctx.accounts.recipient_token_account.owner;

        let policy = &mut ctx.accounts.policy;
        require!(!policy.revoked, GuardError::Revoked);
        require!(now < policy.expires_at, GuardError::Expired);
        require!(amount > 0, GuardError::ZeroAmount);
        require!(amount <= policy.per_tx_cap, GuardError::ExceedsPerTxCap);
        require!(
            policy.allowlist.contains(&recipient_owner),
            GuardError::RecipientNotAllowed
        );

        let elapsed = now
            .checked_sub(policy.day_start)
            .ok_or(GuardError::MathOverflow)?;
        if elapsed >= SECONDS_PER_DAY {
            policy.day_start = now;
            policy.spent_today = 0;
        }
        let new_total = policy
            .spent_today
            .checked_add(amount)
            .ok_or(GuardError::MathOverflow)?;
        require!(new_total <= policy.daily_cap, GuardError::ExceedsDailyCap);
        policy.spent_today = new_total;

        let owner = policy.owner;
        let agent = policy.agent;
        let bump = policy.bump;
        let seeds: &[&[u8]] = &[b"policy", owner.as_ref(), agent.as_ref(), &[bump]];
        let signer = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.policy.to_account_info(),
            },
            signer,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

        emit!(Spent {
            policy: ctx.accounts.policy.key(),
            recipient: recipient_owner,
            amount,
            spent_today: new_total,
            timestamp: now,
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let owner = ctx.accounts.policy.owner;
        let agent = ctx.accounts.policy.agent;
        let bump = ctx.accounts.policy.bump;
        let seeds: &[&[u8]] = &[b"policy", owner.as_ref(), agent.as_ref(), &[bump]];
        let signer = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.policy.to_account_info(),
            },
            signer,
        );
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
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

#[event]
pub struct Spent {
    pub policy: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub spent_today: u64,
    pub timestamp: i64,
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
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ GuardError::NotOwner)]
    pub policy: Account<'info, Policy>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    pub agent: Signer<'info>,
    #[account(
        mut,
        has_one = agent @ GuardError::NotAgent,
        has_one = mint,
        seeds = [b"policy", policy.owner.as_ref(), policy.agent.as_ref()],
        bump = policy.bump
    )]
    pub policy: Account<'info, Policy>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ GuardError::NotOwner,
        has_one = mint,
        seeds = [b"policy", policy.owner.as_ref(), policy.agent.as_ref()],
        bump = policy.bump
    )]
    pub policy: Account<'info, Policy>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
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
    #[msg("Only the policy's agent can spend")]
    NotAgent,
    #[msg("This policy has been revoked")]
    Revoked,
    #[msg("This policy has expired")]
    Expired,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Amount exceeds the per-transaction cap")]
    ExceedsPerTxCap,
    #[msg("Amount would exceed the daily cap")]
    ExceedsDailyCap,
    #[msg("Recipient is not on the allowlist")]
    RecipientNotAllowed,
    #[msg("Math overflow")]
    MathOverflow,
}