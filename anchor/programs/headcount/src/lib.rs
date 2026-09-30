//! Headcount: an event only happens if enough people commit money by a deadline.
//!
//! Ticket events pay the organizer once GO; deposit events return each deposit at
//! check-in and give the no-shows' deposits to the organizer. On NO-GO or
//! cancellation everyone is refunded; anyone may trigger a refund, the tokens only
//! go to the owner's token account. Payouts carry a small protocol fee; refunds and
//! returned deposits never do. Only classic SPL Token mints.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("9NeaXRkbU4Jxsmh2aJyN74gxRoAR7fYupV68FEzDH6KH");

pub const MAX_TITLE_LEN: usize = 64;
/// Caps deadlines so refunds cannot be locked forever.
pub const MAX_DEADLINE_SECS: i64 = 180 * 24 * 60 * 60;
pub const MAX_EVENT_AFTER_DEADLINE_SECS: i64 = 60 * 24 * 60 * 60;
pub const MAX_PASS_SECS: i64 = 120;
/// What the door key signs: prefix || event address || expiry (i64 LE).
pub const PASS_PREFIX: &[u8] = b"headcount-pass:v1";
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const TREASURY: Pubkey = pubkey!("jSVWkBaMrzx6Vwxg3kLnjm4ACTLux2nFqmHLghrQF3B");
/// 2 % of a GO ticket payout.
pub const TICKET_FEE_BPS: u64 = 200;
/// 5 % of the forfeited no-show deposits.
pub const NO_SHOW_FEE_BPS: u64 = 500;

#[program]
pub mod headcount {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn create_event(
        ctx: Context<CreateEvent>,
        event_id: u64,
        kind: EventKind,
        price: u64,
        min_participants: u32,
        max_participants: u32,
        min_amount: u64,
        commit_deadline: i64,
        event_end: i64,
        door_key: Pubkey,
        title: String,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(price > 0, HeadcountError::InvalidPrice);
        require!(min_participants >= 1, HeadcountError::InvalidLimits);
        require!(
            max_participants == 0 || max_participants >= min_participants,
            HeadcountError::InvalidLimits
        );
        require!(
            min_amount == 0 || kind == EventKind::Ticket,
            HeadcountError::BudgetOnlyForTickets
        );
        require!(commit_deadline > now, HeadcountError::InvalidDeadline);
        require!(event_end >= commit_deadline, HeadcountError::InvalidDeadline);
        require!(commit_deadline <= now + MAX_DEADLINE_SECS, HeadcountError::InvalidDeadline);
        require!(
            event_end <= commit_deadline + MAX_EVENT_AFTER_DEADLINE_SECS,
            HeadcountError::InvalidDeadline
        );
        require!(
            !title.is_empty() && title.len() <= MAX_TITLE_LEN,
            HeadcountError::InvalidTitle
        );

        let event = &mut ctx.accounts.event;
        event.organizer = ctx.accounts.organizer.key();
        event.mint = ctx.accounts.mint.key();
        event.event_id = event_id;
        event.kind = kind;
        event.price = price;
        event.min_participants = min_participants;
        event.max_participants = max_participants;
        event.participants = 0;
        event.checked_in = 0;
        event.min_amount = min_amount;
        event.total_committed = 0;
        event.pledged = 0;
        event.backers = 0;
        event.commit_deadline = commit_deadline;
        event.event_end = event_end;
        event.withdrawn = 0;
        event.cancelled = false;
        event.door_key = door_key;
        event.bump = ctx.bumps.event;
        event.title = title;

        emit!(EventCreated {
            event: event.key(),
            organizer: event.organizer,
            kind,
            price,
            min_participants,
            min_amount,
            commit_deadline,
        });
        Ok(())
    }

    /// Pay the ticket price or deposit into the event's vault. Once per person.
    pub fn commit(ctx: Context<Commit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        require!(now < event.commit_deadline, HeadcountError::DeadlinePassed);
        require!(!event.cancelled, HeadcountError::Cancelled);
        require!(
            event.max_participants == 0 || event.participants < event.max_participants,
            HeadcountError::EventFull
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.participant_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.participant.to_account_info(),
                },
            ),
            event.price,
            ctx.accounts.mint.decimals,
        )?;

        let commitment = &mut ctx.accounts.commitment;
        commitment.event = event.key();
        commitment.participant = ctx.accounts.participant.key();
        commitment.amount = event.price;
        commitment.checked_in = false;
        commitment.rent_payer = ctx.accounts.payer.key();
        commitment.bump = ctx.bumps.commitment;

        let event = &mut ctx.accounts.event;
        let was_go = event.is_go();
        event.participants = event
            .participants
            .checked_add(1)
            .ok_or(HeadcountError::Overflow)?;
        event.total_committed = event
            .total_committed
            .checked_add(commitment.amount)
            .ok_or(HeadcountError::Overflow)?;

        emit!(Committed {
            event: event.key(),
            participant: commitment.participant,
            participants: event.participants,
            min_participants: event.min_participants,
            went_go: !was_go && event.is_go(),
        });
        Ok(())
    }

    /// Ticket events: back the event without a seat; counts toward the budget only.
    pub fn pledge(ctx: Context<PledgeCtx>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        require!(event.kind == EventKind::Ticket, HeadcountError::WrongKind);
        require!(now < event.commit_deadline, HeadcountError::DeadlinePassed);
        require!(!event.cancelled, HeadcountError::Cancelled);
        require!(amount > 0, HeadcountError::InvalidPrice);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.backer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.backer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let pledge = &mut ctx.accounts.pledge;
        pledge.event = event.key();
        pledge.backer = ctx.accounts.backer.key();
        pledge.amount = amount;
        pledge.rent_payer = ctx.accounts.payer.key();
        pledge.bump = ctx.bumps.pledge;

        let event = &mut ctx.accounts.event;
        let was_go = event.is_go();
        event.total_committed = event
            .total_committed
            .checked_add(amount)
            .ok_or(HeadcountError::Overflow)?;
        event.pledged = event.pledged.checked_add(amount).ok_or(HeadcountError::Overflow)?;
        event.backers = event.backers.checked_add(1).ok_or(HeadcountError::Overflow)?;
        emit!(Pledged {
            event: event.key(),
            backer: pledge.backer,
            amount,
            went_go: !was_go && event.is_go(),
        });
        Ok(())
    }

    /// Ticket events: once GO and past the deadline, the organizer takes the vault.
    pub fn withdraw(ctx: Context<OrganizerPayout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        require!(event.kind == EventKind::Ticket, HeadcountError::WrongKind);
        require!(!event.cancelled, HeadcountError::Cancelled);
        require!(event.is_go(), HeadcountError::NotGo);
        // Before the deadline the organizer could still cancel after being paid.
        require!(now >= event.commit_deadline, HeadcountError::DeadlineNotReached);
        let amount = ctx.accounts.vault.amount;
        require!(amount > 0, HeadcountError::NothingToWithdraw);
        let fee = payout_with_fee(&ctx, amount, TICKET_FEE_BPS)?;
        let event = &mut ctx.accounts.event;
        event.withdrawn = event.withdrawn.checked_add(amount).ok_or(HeadcountError::Overflow)?;
        emit!(Withdrawn { event: event.key(), amount, fee });
        Ok(())
    }

    /// The organizer calls the event off; only before the commit deadline.
    pub fn cancel_event(ctx: Context<OrganizerOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &mut ctx.accounts.event;
        require!(!event.cancelled, HeadcountError::Cancelled);
        require!(now < event.commit_deadline, HeadcountError::CancelTooLate);
        require!(event.withdrawn == 0 && event.checked_in == 0, HeadcountError::AlreadyPaidOut);
        event.cancelled = true;
        emit!(Cancelled { event: event.key() });
        Ok(())
    }

    /// Register or rotate the door screen key that signs check-in passes.
    pub fn set_door_key(ctx: Context<OrganizerOnly>, door_key: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &mut ctx.accounts.event;
        require!(event.kind == EventKind::Deposit, HeadcountError::WrongKind);
        require!(now <= event.event_end, HeadcountError::EventOver);
        event.door_key = door_key;
        emit!(DoorKeySet { event: event.key(), door_key });
        Ok(())
    }

    /// Refund on NO-GO, cancellation, or a deposit event nobody checked in to.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        refundable(&ctx.accounts.event)?;
        require!(!ctx.accounts.commitment.checked_in, HeadcountError::AlreadyCheckedIn);
        let amount = ctx.accounts.commitment.amount;
        pay_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.participant_token,
            &ctx.accounts.token_program,
            amount,
        )?;
        emit!(Refunded {
            event: ctx.accounts.event.key(),
            participant: ctx.accounts.participant.key(),
            amount,
        });
        Ok(())
    }

    /// Backers get their pledge back under the same rules as participants.
    pub fn refund_pledge(ctx: Context<RefundPledge>) -> Result<()> {
        refundable(&ctx.accounts.event)?;
        let amount = ctx.accounts.pledge.amount;
        pay_from_vault(
            &ctx.accounts.event,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.backer_token,
            &ctx.accounts.token_program,
            amount,
        )?;
        emit!(Refunded {
            event: ctx.accounts.event.key(),
            participant: ctx.accounts.backer.key(),
            amount,
        });
        Ok(())
    }

    /// Deposit events: manual check-in by the organizer (fallback without a phone).
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        check_in_open(&ctx.accounts.event, &ctx.accounts.commitment)?;
        return_deposit(
            &mut ctx.accounts.event,
            &mut ctx.accounts.commitment,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.participant_token,
            &ctx.accounts.token_program,
        )
    }

    /// Self check-in with the door pass. The previous instruction must be the
    /// Ed25519 check of the pass by the door key.
    pub fn check_in_with_pass(ctx: Context<CheckInWithPass>, expires_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        check_in_open(&ctx.accounts.event, &ctx.accounts.commitment)?;
        let event = &ctx.accounts.event;
        require!(event.door_key != Pubkey::default(), HeadcountError::NoDoorScreen);
        require!(now <= expires_at, HeadcountError::PassExpired);
        require!(expires_at <= now + MAX_PASS_SECS, HeadcountError::InvalidPass);
        let mut message = PASS_PREFIX.to_vec();
        message.extend_from_slice(event.key().as_ref());
        message.extend_from_slice(&expires_at.to_le_bytes());
        verify_signed_by(&ctx.accounts.instructions, &event.door_key, &message)?;
        return_deposit(
            &mut ctx.accounts.event,
            &mut ctx.accounts.commitment,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.participant_token,
            &ctx.accounts.token_program,
        )
    }

    /// After a settled event, close a commitment and return its rent. Permissionless.
    pub fn close_commitment(ctx: Context<CloseCommitment>) -> Result<()> {
        settled(&ctx.accounts.event)
    }

    /// After a settled event, close a pledge and return its rent to its payer.
    pub fn close_pledge(ctx: Context<ClosePledge>) -> Result<()> {
        settled(&ctx.accounts.event)
    }

    /// Deposit events: after the event the no-shows' deposits go to the organizer.
    pub fn sweep(ctx: Context<OrganizerPayout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let event = &ctx.accounts.event;
        require!(event.kind == EventKind::Deposit, HeadcountError::WrongKind);
        require!(!event.cancelled, HeadcountError::Cancelled);
        require!(event.is_go(), HeadcountError::NotGo);
        require!(now > event.event_end, HeadcountError::EventNotOver);
        require!(event.checked_in > 0, HeadcountError::NobodyCheckedIn);
        let amount = ctx.accounts.vault.amount;
        require!(amount > 0, HeadcountError::NothingToWithdraw);
        let fee = payout_with_fee(&ctx, amount, NO_SHOW_FEE_BPS)?;
        let event = &mut ctx.accounts.event;
        event.withdrawn = event.withdrawn.checked_add(amount).ok_or(HeadcountError::Overflow)?;
        emit!(Swept {
            event: event.key(),
            amount,
            fee,
            no_shows: event.participants - event.checked_in,
        });
        Ok(())
    }

    /// NO-GO or cancelled and every refund taken: the organizer closes the event
    /// and its vault. In a refundable event only refunds empty the vault, so an
    /// empty vault means no commitment or pledge account is left.
    pub fn close_event(ctx: Context<CloseEvent>) -> Result<()> {
        refundable(&ctx.accounts.event)?;
        require!(ctx.accounts.vault.amount == 0, HeadcountError::VaultNotEmpty);
        let seeds = event_seeds(&ctx.accounts.event);
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.organizer.to_account_info(),
                authority: ctx.accounts.event.to_account_info(),
            },
            &[&seeds.iter().map(|s| s.as_slice()).collect::<Vec<_>>()],
        ))
    }
}

fn settled(event: &Event) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now > event.event_end, HeadcountError::EventNotOver);
    require!(refundable(event).is_err(), HeadcountError::StillRefundable);
    Ok(())
}

fn refundable(event: &Event) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let no_go = now >= event.commit_deadline && !event.is_go();
    let not_held =
        event.kind == EventKind::Deposit && now > event.event_end && event.checked_in == 0;
    if no_go || event.cancelled || not_held {
        return Ok(());
    }
    if now < event.commit_deadline {
        return err!(HeadcountError::DeadlineNotReached);
    }
    err!(HeadcountError::EventIsGo)
}

fn check_in_open(event: &Event, commitment: &Commitment) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(event.kind == EventKind::Deposit, HeadcountError::WrongKind);
    require!(!event.cancelled, HeadcountError::Cancelled);
    require!(event.is_go(), HeadcountError::NotGo);
    // No early check-in: one friendly wallet checked in would unlock the sweep.
    require!(now >= event.commit_deadline, HeadcountError::CheckInNotOpen);
    require!(now <= event.event_end, HeadcountError::EventOver);
    require!(!commitment.checked_in, HeadcountError::AlreadyCheckedIn);
    Ok(())
}

fn return_deposit<'info>(
    event: &mut Account<'info, Event>,
    commitment: &mut Account<'info, Commitment>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    pay_from_vault(event, vault, mint, to, token_program, commitment.amount)?;
    commitment.checked_in = true;
    event.checked_in = event.checked_in.checked_add(1).ok_or(HeadcountError::Overflow)?;
    emit!(CheckedIn {
        event: event.key(),
        participant: commitment.participant,
        checked_in: event.checked_in,
    });
    Ok(())
}

/// The previous instruction must be an Ed25519 check of exactly `message` by
/// `signer`, with all data inline (offsets elsewhere could smuggle in bytes).
fn verify_signed_by(instructions: &AccountInfo, signer: &Pubkey, message: &[u8]) -> Result<()> {
    let current = load_current_index_checked(instructions)?;
    require!(current > 0, HeadcountError::InvalidPass);
    let ix = load_instruction_at_checked((current - 1) as usize, instructions)?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, HeadcountError::InvalidPass);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, HeadcountError::InvalidPass);
    let u16_at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
    let (sig_off, sig_ix) = (u16_at(2) as usize, u16_at(4));
    let (key_off, key_ix) = (u16_at(6) as usize, u16_at(8));
    let (msg_off, msg_len, msg_ix) = (u16_at(10) as usize, u16_at(12) as usize, u16_at(14));
    require!(
        sig_ix == u16::MAX && key_ix == u16::MAX && msg_ix == u16::MAX,
        HeadcountError::InvalidPass
    );
    require!(
        d.len() >= sig_off + 64 && d.len() >= key_off + 32 && d.len() >= msg_off + msg_len,
        HeadcountError::InvalidPass
    );
    require!(&d[key_off..key_off + 32] == signer.as_ref(), HeadcountError::InvalidPass);
    require!(&d[msg_off..msg_off + msg_len] == message, HeadcountError::InvalidPass);
    Ok(())
}

fn event_seeds(event: &Event) -> Vec<Vec<u8>> {
    vec![
        b"event".to_vec(),
        event.organizer.to_bytes().to_vec(),
        event.event_id.to_le_bytes().to_vec(),
        vec![event.bump],
    ]
}

fn pay_from_vault<'info>(
    event: &Account<'info, Event>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let seeds = event_seeds(event);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: event.to_account_info(),
            },
            &[&seeds.iter().map(|s| s.as_slice()).collect::<Vec<_>>()],
        ),
        amount,
        mint.decimals,
    )
}

/// Pays `amount` out of the vault: the fee (rounded down) to the treasury, the
/// rest to the organizer. A frozen treasury account never blocks a payout.
fn payout_with_fee(ctx: &Context<OrganizerPayout>, amount: u64, fee_bps: u64) -> Result<u64> {
    let fee = if ctx.accounts.treasury_token.is_frozen() {
        0
    } else {
        u64::try_from(amount as u128 * fee_bps as u128 / 10_000)
            .map_err(|_| error!(HeadcountError::Overflow))?
    };
    let a = &ctx.accounts;
    if fee > 0 {
        pay_from_vault(&a.event, &a.vault, &a.mint, &a.treasury_token, &a.token_program, fee)?;
    }
    let rest = amount.checked_sub(fee).ok_or(HeadcountError::Overflow)?;
    pay_from_vault(&a.event, &a.vault, &a.mint, &a.organizer_token, &a.token_program, rest)?;
    Ok(fee)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EventKind {
    Ticket,
    Deposit,
}

#[account]
#[derive(InitSpace)]
pub struct Event {
    pub organizer: Pubkey,
    pub mint: Pubkey,
    pub event_id: u64,
    pub kind: EventKind,
    pub price: u64,
    pub min_participants: u32,
    pub max_participants: u32,
    pub participants: u32,
    pub checked_in: u32,
    /// Budget goal for tickets + pledges (0 = none).
    pub min_amount: u64,
    /// Tickets plus pledges; never decreases before the outcome.
    pub total_committed: u64,
    pub pledged: u64,
    pub backers: u32,
    pub commit_deadline: i64,
    pub event_end: i64,
    pub withdrawn: u64,
    pub cancelled: bool,
    /// Signs door passes (default = no door screen yet).
    pub door_key: Pubkey,
    pub bump: u8,
    #[max_len(MAX_TITLE_LEN)]
    pub title: String,
}

impl Event {
    /// Pledges can close the money gap, never the people gap.
    pub fn is_go(&self) -> bool {
        self.participants >= self.min_participants && self.total_committed >= self.min_amount
    }
}

#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub event: Pubkey,
    pub participant: Pubkey,
    pub amount: u64,
    pub checked_in: bool,
    /// Gets the rent back on close (the participant or a sponsoring app).
    pub rent_payer: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pledge {
    pub event: Pubkey,
    pub backer: Pubkey,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct CreateEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(
        init,
        payer = organizer,
        space = 8 + Event::INIT_SPACE,
        seeds = [b"event", organizer.key().as_ref(), &event_id.to_le_bytes()],
        bump
    )]
    pub event: Account<'info, Event>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    // init_if_needed: anyone could pre-create this canonical ATA to block the event.
    #[account(
        init_if_needed,
        payer = organizer,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// Classic SPL Token only: Token-2022 fees, hooks or delegates could drain the vault.
    #[account(address = anchor_spl::token::ID @ HeadcountError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OrganizerOnly<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer)]
    pub event: Account<'info, Event>,
}

#[derive(Accounts)]
pub struct Commit<'info> {
    pub participant: Signer<'info>,
    /// Pays fees and account rent: the participant, or the app on their behalf.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = payer,
        space = 8 + Commitment::INIT_SPACE,
        seeds = [b"commit", event.key().as_ref(), participant.key().as_ref()],
        bump
    )]
    pub commitment: Account<'info, Commitment>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = participant,
        token::token_program = token_program
    )]
    pub participant_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PledgeCtx<'info> {
    pub backer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pledge::INIT_SPACE,
        seeds = [b"pledge", event.key().as_ref(), backer.key().as_ref()],
        bump
    )]
    pub pledge: Account<'info, Pledge>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = backer,
        token::token_program = token_program
    )]
    pub backer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OrganizerPayout<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, has_one = mint)]
    pub event: Account<'info, Event>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = organizer,
        token::token_program = token_program
    )]
    pub organizer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the fixed protocol treasury (address check).
    #[account(address = TREASURY @ HeadcountError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program
    )]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct CloseEvent<'info> {
    #[account(mut)]
    pub organizer: Signer<'info>,
    #[account(mut, close = organizer, has_one = organizer, has_one = mint)]
    pub event: Account<'info, Event>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = anchor_spl::token::ID @ HeadcountError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// CHECK: owner of the commitment (seeds + has_one). Need not sign: anyone may
    /// trigger a refund, and the tokens can only reach this owner's token account.
    pub participant: UncheckedAccount<'info>,
    #[account(has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"commit", event.key().as_ref(), participant.key().as_ref()],
        bump = commitment.bump,
        has_one = event,
        has_one = participant,
        has_one = rent_payer
    )]
    pub commitment: Account<'info, Commitment>,
    /// CHECK: receives the account rent back; must be who paid it (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = participant,
        associated_token::token_program = token_program
    )]
    pub participant_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = anchor_spl::token::ID @ HeadcountError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundPledge<'info> {
    /// CHECK: owner of the pledge (seeds + has_one); need not sign, see Refund.
    pub backer: UncheckedAccount<'info>,
    #[account(has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"pledge", event.key().as_ref(), backer.key().as_ref()],
        bump = pledge.bump,
        has_one = event,
        has_one = backer,
        has_one = rent_payer
    )]
    pub pledge: Account<'info, Pledge>,
    /// CHECK: receives the account rent back; must be who paid it (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = backer,
        associated_token::token_program = token_program
    )]
    pub backer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = anchor_spl::token::ID @ HeadcountError::UnsupportedMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CheckIn<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        seeds = [b"commit", event.key().as_ref(), commitment.participant.as_ref()],
        bump = commitment.bump,
        has_one = event
    )]
    pub commitment: Account<'info, Commitment>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = commitment.participant,
        token::token_program = token_program
    )]
    pub participant_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseCommitment<'info> {
    pub event: Account<'info, Event>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"commit", event.key().as_ref(), commitment.participant.as_ref()],
        bump = commitment.bump,
        has_one = event,
        has_one = rent_payer
    )]
    pub commitment: Account<'info, Commitment>,
    /// CHECK: receives the account rent back; must be who paid it (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClosePledge<'info> {
    pub event: Account<'info, Event>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [b"pledge", event.key().as_ref(), pledge.backer.as_ref()],
        bump = pledge.bump,
        has_one = event,
        has_one = rent_payer
    )]
    pub pledge: Account<'info, Pledge>,
    /// CHECK: receives the account rent back; must be who paid it (has_one).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CheckInWithPass<'info> {
    pub participant: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub event: Account<'info, Event>,
    #[account(
        mut,
        seeds = [b"commit", event.key().as_ref(), participant.key().as_ref()],
        bump = commitment.bump,
        has_one = event,
        has_one = participant
    )]
    pub commitment: Account<'info, Commitment>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = event,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = participant,
        token::token_program = token_program
    )]
    pub participant_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the instructions sysvar, to read the Ed25519 check before us.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[event]
pub struct EventCreated {
    pub event: Pubkey,
    pub organizer: Pubkey,
    pub kind: EventKind,
    pub price: u64,
    pub min_participants: u32,
    pub min_amount: u64,
    pub commit_deadline: i64,
}

#[event]
pub struct Committed {
    pub event: Pubkey,
    pub participant: Pubkey,
    pub participants: u32,
    pub min_participants: u32,
    pub went_go: bool,
}

#[event]
pub struct Pledged {
    pub event: Pubkey,
    pub backer: Pubkey,
    pub amount: u64,
    pub went_go: bool,
}

#[event]
pub struct Cancelled {
    pub event: Pubkey,
}

#[event]
pub struct DoorKeySet {
    pub event: Pubkey,
    pub door_key: Pubkey,
}

#[event]
pub struct Withdrawn {
    pub event: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct Refunded {
    pub event: Pubkey,
    pub participant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CheckedIn {
    pub event: Pubkey,
    pub participant: Pubkey,
    pub checked_in: u32,
}

#[event]
pub struct Swept {
    pub event: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub no_shows: u32,
}

#[error_code]
pub enum HeadcountError {
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Minimum must be at least 1 and not above the maximum")]
    InvalidLimits,
    #[msg("Deadline must be in the future and not after the event end")]
    InvalidDeadline,
    #[msg("Title must be 1 to 64 bytes")]
    InvalidTitle,
    #[msg("The commit deadline has passed")]
    DeadlinePassed,
    #[msg("The deadline has not been reached yet")]
    DeadlineNotReached,
    #[msg("The event is full")]
    EventFull,
    #[msg("Wrong event kind for this action")]
    WrongKind,
    #[msg("The event has not reached its minimum (not GO)")]
    NotGo,
    #[msg("The event reached its minimum (GO); no refunds")]
    EventIsGo,
    #[msg("The vault is empty")]
    NothingToWithdraw,
    #[msg("The event is over")]
    EventOver,
    #[msg("The event is not over yet")]
    EventNotOver,
    #[msg("Already checked in")]
    AlreadyCheckedIn,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The event was cancelled")]
    Cancelled,
    #[msg("Money was already paid out or people checked in; cannot cancel")]
    AlreadyPaidOut,
    #[msg("Nobody was checked in; participants take their deposits back instead")]
    NobodyCheckedIn,
    #[msg("Only classic SPL Token mints such as USDC are supported")]
    UnsupportedMint,
    #[msg("The commit deadline has passed; the event can no longer be cancelled")]
    CancelTooLate,
    #[msg("Check-in opens at the commit deadline")]
    CheckInNotOpen,
    #[msg("A budget goal is only possible for ticket events")]
    BudgetOnlyForTickets,
    #[msg("This event has no door screen yet; ask the organizer")]
    NoDoorScreen,
    #[msg("This door pass is not valid for this event")]
    InvalidPass,
    #[msg("This door pass has expired; scan the current one")]
    PassExpired,
    #[msg("Refunds are still possible for this event; the account stays open")]
    StillRefundable,
    #[msg("This is not the protocol treasury")]
    WrongTreasury,
    #[msg("The vault still holds tokens; refunds are not all taken yet")]
    VaultNotEmpty,
}
