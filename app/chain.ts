import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const bs58 = anchor.utils.bytes.bs58;

/** Protocol fee (lib.rs): taken from organizer payouts, never from refunds. */
export const TREASURY = new PublicKey(
  "jSVWkBaMrzx6Vwxg3kLnjm4ACTLux2nFqmHLghrQF3B",
);
export const TICKET_FEE_BPS = 200n;
export const NO_SHOW_FEE_BPS = 500n;
export const feeOf = (amount: bigint, bps: bigint) => (amount * bps) / 10_000n;

export const PROGRAM_ID = new PublicKey(
  "9NeaXRkbU4Jxsmh2aJyN74gxRoAR7fYupV68FEzDH6KH",
);
const IDL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../anchor/target/idl/headcount.json",
);

/** An error whose message is safe and helpful to show to the user. */
export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type Kind = "ticket" | "deposit";
export type Status = "OPEN" | "GO" | "NO-GO" | "DONE" | "CANCELLED";
export type Action = "commit" | "refund" | "closed";

/** Mirrors the program's limits (lib.rs MAX_DEADLINE_SECS etc.). */
export const MAX_DEADLINE_SECS = 180 * 24 * 60 * 60;
export const MAX_EVENT_AFTER_DEADLINE_SECS = 60 * 24 * 60 * 60;
export const MAX_PASS_SECS = 120;
/** What the door key signs: prefix || event address || expiry (i64 LE). */
export const PASS_PREFIX = "headcount-pass:v1";
export const U64_MAX = 2n ** 64n - 1n;
const DEFAULT_KEY = PublicKey.default.toBase58();

export interface EventView {
  address: string;
  organizer: string;
  mint: string;
  eventId: string;
  kind: Kind;
  /** u64 base units as a decimal integer string (never a JS number). */
  price: string;
  minParticipants: number;
  maxParticipants: number;
  participants: number;
  checkedIn: number;
  /** Budget goal in base units ("0" = no budget). */
  minAmount: string;
  /** Tickets + pledges. */
  totalCommitted: string;
  pledged: string;
  backers: number;
  commitDeadline: number;
  eventEnd: number;
  withdrawn: string;
  cancelled: boolean;
  doorKey: string | null;
  title: string;
}

export interface CommitmentView {
  address: string;
  participant: string;
  amount: string;
  checkedIn: boolean;
  rentPayer: string;
}

export interface PledgeView {
  address: string;
  backer: string;
  amount: string;
  rentPayer: string;
}

/** Mirrors lib.rs is_go. */
export function isGo(e: EventView): boolean {
  return (
    e.participants >= e.minParticipants &&
    BigInt(e.totalCommitted) >= BigInt(e.minAmount)
  );
}

export function statusOf(e: EventView, now: number): Status {
  if (e.cancelled) return "CANCELLED";
  if (isGo(e)) return now > e.eventEnd ? "DONE" : "GO";
  return now >= e.commitDeadline ? "NO-GO" : "OPEN";
}

/** Same rule as the program's `refundable`. */
export function refundable(e: EventView, now: number): boolean {
  const noGo = now >= e.commitDeadline && !isGo(e);
  const notHeld = e.kind === "deposit" && now > e.eventEnd && e.checkedIn === 0;
  return noGo || e.cancelled || notHeld;
}

export function actionOf(e: EventView, now: number): Action {
  if (refundable(e, now)) return "refund";
  return now < e.commitDeadline ? "commit" : "closed";
}

/** Mirrors the program's cancel_event checks. */
export function cancellable(e: EventView, now: number): boolean {
  return (
    !e.cancelled &&
    now < e.commitDeadline &&
    BigInt(e.withdrawn) === 0n &&
    e.checkedIn === 0
  );
}

/** Mirrors the program's check_in_open. */
export function checkInOpen(e: EventView, now: number): boolean {
  return (
    e.kind === "deposit" &&
    !e.cancelled &&
    isGo(e) &&
    now >= e.commitDeadline &&
    now <= e.eventEnd
  );
}

export function passMessage(event: PublicKey, expiresAt: number): Buffer {
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(BigInt(expiresAt));
  return Buffer.concat([Buffer.from(PASS_PREFIX), event.toBuffer(), exp]);
}

/** Node's crypto wants SPKI DER: fixed Ed25519 prefix + raw 32-byte key. */
export function verifyEd25519(
  publicKey: PublicKey,
  message: Buffer,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKey.toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  try {
    return edVerify(null, message, key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** For logs that carry only the error name, or an IDL older than the program. */
const ERROR_MESSAGES: Record<string, string> = {
  CancelTooLate:
    "The commit deadline has passed; the event can no longer be cancelled",
  CheckInNotOpen: "Check-in opens at the commit deadline",
  NoDoorScreen: "This event has no door screen yet; ask the organizer",
  InvalidPass: "This door pass is not valid for this event",
  PassExpired: "This door pass has expired; scan the current one",
  AlreadyCheckedIn: "Already checked in",
  BudgetOnlyForTickets: "A budget goal is only possible for ticket events",
};

export function parsePubkey(value: unknown, what = "account"): PublicKey {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new UserError(
      `Invalid ${what}: expected a base58 Solana public key.`,
    );
  try {
    return new PublicKey(value);
  } catch {
    throw new UserError(
      `Invalid ${what}: expected a base58 Solana public key.`,
    );
  }
}

export function parseSecretKey(value: string): Keypair {
  const v = value.trim();
  const bytes = v.startsWith("[")
    ? Uint8Array.from(JSON.parse(v) as number[])
    : bs58.decode(v);
  return Keypair.fromSecretKey(bytes);
}

const u64 = (v: unknown) =>
  BigInt((v as { toString(): string }).toString()).toString();
const secs = (v: unknown) => Number((v as { toString(): string }).toString());

export interface Built {
  ixs: TransactionInstruction[];
  feePayer: PublicKey;
  /** Keys the server signs with before handing the tx to the wallet. */
  signers: Keypair[];
}

export class Chain {
  readonly connection: Connection;
  readonly program: InstanceType<typeof Program>;
  private tokenCache = new Map<
    string,
    { programId: PublicKey; decimals: number }
  >();
  private nowCache = { at: 0, value: 0 };
  private errorMessages = new Map<number, string>();
  /** The app's configured stablecoin mint (MINT); only it is called `symbol`. */
  readonly appMint?: string;
  readonly symbol: string;
  readonly sponsor?: Keypair;

  constructor(
    rpcUrl: string,
    opts: { appMint?: string; symbol?: string; sponsor?: Keypair } = {},
  ) {
    this.appMint = opts.appMint;
    this.symbol = opts.symbol ?? "USDC";
    this.sponsor = opts.sponsor;
    this.connection = new Connection(rpcUrl, "confirmed");
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
    for (const e of idl.errors ?? []) this.errorMessages.set(e.code, e.msg);
    // Dummy wallet: the server never signs as a user.
    const provider = new AnchorProvider(
      this.connection,
      new Wallet(Keypair.generate()),
      { commitment: "confirmed" },
    );
    this.program = new Program(idl, provider);
  }

  private get methods(): any {
    return this.program.methods;
  }

  /** The sponsor if within its limits, else the wallet itself (needs SOL).
   *  Rebuilding the same action within two minutes (wallets fetch a transaction
   *  request more than once) does not use up another sponsored slot. */
  private payerFor(
    account: PublicKey,
    action: string,
  ): Pick<Built, "feePayer" | "signers"> {
    const self = { feePayer: account, signers: [] as Keypair[] };
    if (!this.sponsor) return self;
    const sponsored = { feePayer: this.sponsor.publicKey, signers: [this.sponsor] };
    const key = `${action}:${account.toBase58()}`;
    const now = Date.now();
    if ((this.recentSponsored.get(key) ?? 0) > now - 120_000) return sponsored;
    if (!this.sponsorLimits.allow(account.toBase58(), now)) return self;
    this.recentSponsored.set(key, now);
    if (this.recentSponsored.size > 5000)
      for (const [k, t] of this.recentSponsored)
        if (t < now - 120_000) this.recentSponsored.delete(k);
    return sponsored;
  }
  private readonly recentSponsored = new Map<string, number>();

  /** Keeps a public sponsor wallet from being drained by one visitor. */
  private readonly sponsorLimits = new SponsorLimits(
    Number(process.env.SPONSOR_PER_WALLET_PER_HOUR ?? 6),
    Number(process.env.SPONSOR_PER_DAY ?? 300),
  );

  eventPda(organizer: PublicKey, eventId: bigint): PublicKey {
    const id = Buffer.alloc(8);
    id.writeBigUInt64LE(eventId);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("event"), organizer.toBuffer(), id],
      PROGRAM_ID,
    )[0];
  }

  commitPda(event: PublicKey, participant: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("commit"), event.toBuffer(), participant.toBuffer()],
      PROGRAM_ID,
    )[0];
  }

  pledgePda(event: PublicKey, backer: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pledge"), event.toBuffer(), backer.toBuffer()],
      PROGRAM_ID,
    )[0];
  }

  vaultOf(mint: PublicKey, event: PublicKey, tokenProgram: PublicKey) {
    return getAssociatedTokenAddressSync(mint, event, true, tokenProgram);
  }

  async tokenInfo(mint: PublicKey) {
    const key = mint.toBase58();
    const hit = this.tokenCache.get(key);
    if (hit) return hit;
    const info = await this.connection.getAccountInfo(mint);
    if (!info)
      throw new UserError(`Mint ${key} not found on this cluster.`, 500);
    const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const m = await getMint(this.connection, mint, "confirmed", programId);
    const value = { programId, decimals: m.decimals };
    this.tokenCache.set(key, value);
    return value;
  }

  /** Cluster time (what the program's Clock sees), cached for a second. */
  async chainNow(): Promise<number> {
    if (Date.now() - this.nowCache.at < 1000) return this.nowCache.value;
    let value = Math.floor(Date.now() / 1000);
    try {
      const t = await this.connection.getBlockTime(
        await this.connection.getSlot("confirmed"),
      );
      if (t) value = t;
    } catch {
      /* fall back to wall clock */
    }
    this.nowCache = { at: Date.now(), value };
    return value;
  }

  async isDeployed(): Promise<boolean> {
    const info = await this.connection.getAccountInfo(PROGRAM_ID);
    return !!info?.executable;
  }

  private toEventView(address: PublicKey, a: any): EventView {
    const door = a.doorKey?.toBase58?.() ?? DEFAULT_KEY;
    return {
      address: address.toBase58(),
      organizer: a.organizer.toBase58(),
      mint: a.mint.toBase58(),
      eventId: a.eventId.toString(),
      kind: "deposit" in a.kind ? "deposit" : "ticket",
      price: u64(a.price),
      minParticipants: a.minParticipants,
      maxParticipants: a.maxParticipants,
      participants: a.participants,
      checkedIn: a.checkedIn,
      minAmount: u64(a.minAmount),
      totalCommitted: u64(a.totalCommitted),
      pledged: u64(a.pledged),
      backers: a.backers,
      commitDeadline: secs(a.commitDeadline),
      eventEnd: secs(a.eventEnd),
      withdrawn: u64(a.withdrawn),
      cancelled: !!a.cancelled,
      doorKey: door === DEFAULT_KEY ? null : door,
      title: a.title,
    };
  }

  async getEvent(address: PublicKey): Promise<EventView | null> {
    const info = await this.connection.getAccountInfo(address);
    if (!info || !info.owner.equals(PROGRAM_ID)) return null;
    try {
      return this.toEventView(
        address,
        this.program.coder.accounts.decode("event", info.data),
      );
    } catch {
      return null;
    }
  }

  isAppToken(e: EventView): boolean {
    return !!this.appMint && e.mint === this.appMint;
  }

  async mustGetEvent(address: PublicKey): Promise<EventView> {
    const e = await this.getEvent(address);
    if (!e) throw new UserError("Event not found.", 404);
    if (!this.isAppToken(e))
      throw new UserError(
        `This event uses a different token than this app (mint ${e.mint}).`,
        400,
      );
    return e;
  }

  private async eventsWhere(
    filters: { memcmp: { offset: number; bytes: string } }[],
  ) {
    const disc = this.program.coder.accounts.memcmp("event");
    const accounts = await this.connection.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: disc }, ...filters],
    });
    const out: EventView[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        out.push(
          this.toEventView(
            pubkey,
            this.program.coder.accounts.decode("event", account.data),
          ),
        );
      } catch {
        /* skip accounts with an unexpected layout */
      }
    }
    return out;
  }

  /** Offset 8 + 32 is Event.mint: other tokens stay off the landing page. */
  allEvents(mint?: string) {
    return this.eventsWhere(
      mint ? [{ memcmp: { offset: 8 + 32, bytes: mint } }] : [],
    );
  }

  /** Event ids are unique only per organizer, hence the PDA of both. */
  async findEvent(
    organizer: PublicKey,
    eventId: bigint,
  ): Promise<EventView | null> {
    const e = await this.getEvent(this.eventPda(organizer, eventId));
    return e &&
      e.organizer === organizer.toBase58() &&
      e.eventId === eventId.toString()
      ? e
      : null;
  }

  private async byEvent(account: "commitment" | "pledge", event: PublicKey) {
    const disc = this.program.coder.accounts.memcmp(account);
    return this.connection.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { memcmp: disc },
        { memcmp: { offset: 8, bytes: event.toBase58() } },
      ],
    });
  }

  async commitments(event: PublicKey): Promise<CommitmentView[]> {
    return (await this.byEvent("commitment", event)).map(
      ({ pubkey, account }) => {
        const c = this.program.coder.accounts.decode(
          "commitment",
          account.data,
        );
        return {
          address: pubkey.toBase58(),
          participant: c.participant.toBase58(),
          amount: u64(c.amount),
          checkedIn: c.checkedIn as boolean,
          rentPayer: c.rentPayer.toBase58(),
        };
      },
    );
  }

  async pledges(event: PublicKey): Promise<PledgeView[]> {
    return (await this.byEvent("pledge", event)).map(({ pubkey, account }) => {
      const p = this.program.coder.accounts.decode("pledge", account.data);
      return {
        address: pubkey.toBase58(),
        backer: p.backer.toBase58(),
        amount: u64(p.amount),
        rentPayer: p.rentPayer.toBase58(),
      };
    });
  }

  async getCommitment(event: PublicKey, participant: PublicKey) {
    const info = await this.connection.getAccountInfo(
      this.commitPda(event, participant),
    );
    if (!info) return null;
    const c = this.program.coder.accounts.decode("commitment", info.data);
    return {
      amount: u64(c.amount),
      checkedIn: c.checkedIn as boolean,
      rentPayer: c.rentPayer as PublicKey,
    };
  }

  async getPledge(event: PublicKey, backer: PublicKey) {
    const info = await this.connection.getAccountInfo(
      this.pledgePda(event, backer),
    );
    if (!info) return null;
    const p = this.program.coder.accounts.decode("pledge", info.data);
    return { amount: u64(p.amount), rentPayer: p.rentPayer as PublicKey };
  }

  async tokenBalance(address: PublicKey): Promise<bigint | null> {
    try {
      const b = await this.connection.getTokenAccountBalance(
        address,
        "confirmed",
      );
      return BigInt(b.value.amount);
    } catch {
      return null;
    }
  }

  async vaultBalance(e: EventView): Promise<bigint> {
    const mint = new PublicKey(e.mint);
    const { programId } = await this.tokenInfo(mint);
    return (
      (await this.tokenBalance(
        this.vaultOf(mint, new PublicKey(e.address), programId),
      )) ?? 0n
    );
  }

  async buildCreate(
    organizer: PublicKey,
    p: {
      eventId: bigint;
      kind: Kind;
      price: bigint;
      min: number;
      max: number;
      minAmount: bigint;
      deadline: number;
      end: number;
      title: string;
      mint: PublicKey;
    },
  ) {
    const now = await this.chainNow();
    if (p.deadline <= now)
      throw new UserError("The commit deadline must be in the future.");
    if (p.end < p.deadline)
      throw new UserError(
        "The event end must not be before the commit deadline.",
      );
    if (p.deadline > now + MAX_DEADLINE_SECS)
      throw new UserError(
        "The commit deadline can be at most 180 days in the future.",
      );
    if (p.end > p.deadline + MAX_EVENT_AFTER_DEADLINE_SECS)
      throw new UserError(
        "The event end can be at most 60 days after the commit deadline.",
      );
    if (p.minAmount > 0n && p.kind !== "ticket")
      throw new UserError(`${ERROR_MESSAGES.BudgetOnlyForTickets}.`);
    const event = this.eventPda(organizer, p.eventId);
    if (await this.connection.getAccountInfo(event))
      throw new UserError(
        "This create link was already used. Open /new to create another event.",
        409,
      );
    const { programId } = await this.tokenInfo(p.mint);
    if (!programId.equals(TOKEN_PROGRAM_ID))
      throw new UserError(
        "Only classic SPL Token mints such as USDC are supported (MINT is a Token-2022 mint).",
        500,
      );
    const ix = await this.methods
      .createEvent(
        new BN(p.eventId.toString()),
        p.kind === "ticket" ? { ticket: {} } : { deposit: {} },
        new BN(p.price.toString()),
        p.min,
        p.max,
        new BN(p.minAmount.toString()),
        new BN(p.deadline),
        new BN(p.end),
        PublicKey.default,
        p.title,
      )
      .accountsPartial({
        organizer,
        event,
        mint: p.mint,
        vault: this.vaultOf(p.mint, event, programId),
        tokenProgram: programId,
      })
      .instruction();
    return { event, ixs: [ix], feePayer: organizer, signers: [] };
  }

  private async payIn(e: EventView, who: PublicKey, amount: bigint) {
    const mint = new PublicKey(e.mint);
    const { programId, decimals } = await this.tokenInfo(mint);
    const token = getAssociatedTokenAddressSync(mint, who, false, programId);
    const have = (await this.tokenBalance(token)) ?? 0n;
    if (have < amount)
      throw new UserError(
        `You need ${formatUnits(amount, decimals)} ${this.symbol} in this wallet (you have ${formatUnits(have, decimals)}).`,
        409,
      );
    if (!this.sponsor && (await this.connection.getBalance(who)) === 0)
      throw new UserError(
        "This wallet has no SOL on this cluster to pay the network fee.",
        409,
      );
    return { mint, programId, decimals, token };
  }

  async buildCommit(eventKey: PublicKey, participant: PublicKey) {
    const e = await this.mustGetEvent(eventKey);
    const now = await this.chainNow();
    if (e.cancelled)
      throw new UserError("This event was cancelled by the organizer.", 409);
    if (now >= e.commitDeadline)
      throw new UserError("The commit deadline has passed.", 409);
    if (e.maxParticipants && e.participants >= e.maxParticipants)
      throw new UserError("This event is full.", 409);
    if (await this.getCommitment(eventKey, participant))
      throw new UserError(
        "This wallet has already committed to this event.",
        409,
      );
    const price = BigInt(e.price);
    const { mint, programId, decimals, token } = await this.payIn(
      e,
      participant,
      price,
    );
    const pay = this.payerFor(participant, `commit:${eventKey}`);
    const ix = await this.methods
      .commit()
      .accountsPartial({
        participant,
        payer: pay.feePayer,
        event: eventKey,
        commitment: this.commitPda(eventKey, participant),
        mint,
        participantToken: token,
        vault: this.vaultOf(mint, eventKey, programId),
        tokenProgram: programId,
      })
      .instruction();
    return { e, ixs: [ix], ...pay, amount: formatUnits(price, decimals) };
  }

  async buildPledge(eventKey: PublicKey, backer: PublicKey, amount: bigint) {
    const e = await this.mustGetEvent(eventKey);
    const now = await this.chainNow();
    if (e.kind !== "ticket")
      throw new UserError("Only ticket events can be backed.", 409);
    if (e.cancelled)
      throw new UserError("This event was cancelled by the organizer.", 409);
    if (now >= e.commitDeadline)
      throw new UserError("The commit deadline has passed.", 409);
    if (amount <= 0n || amount > U64_MAX)
      throw new UserError("Pledge a positive amount.");
    if (await this.getPledge(eventKey, backer))
      throw new UserError(
        "This wallet has already backed this event (one pledge per wallet).",
        409,
      );
    const { mint, programId, decimals, token } = await this.payIn(
      e,
      backer,
      amount,
    );
    const pay = this.payerFor(backer, `pledge:${eventKey}`);
    const ix = await this.methods
      .pledge(new BN(amount.toString()))
      .accountsPartial({
        backer,
        payer: pay.feePayer,
        event: eventKey,
        pledge: this.pledgePda(eventKey, backer),
        mint,
        backerToken: token,
        vault: this.vaultOf(mint, eventKey, programId),
        tokenProgram: programId,
      })
      .instruction();
    return { e, ixs: [ix], ...pay, amount: formatUnits(amount, decimals) };
  }

  /** Refunds commitment and pledge in one tx; `only` restricts it to one. */
  async buildRefund(
    eventKey: PublicKey,
    wallet: PublicKey,
    only?: "commitment" | "pledge",
  ) {
    const e = await this.mustGetEvent(eventKey);
    const c =
      only === "pledge" ? null : await this.getCommitment(eventKey, wallet);
    const p =
      only === "commitment" ? null : await this.getPledge(eventKey, wallet);
    if (!c && !p)
      throw new UserError(
        only === "pledge"
          ? "No pledge from this wallet (maybe it was already refunded)."
          : "No commitment from this wallet (maybe it was already refunded).",
        409,
      );
    const now = await this.chainNow();
    if (!refundable(e, now)) {
      if (now < e.commitDeadline)
        throw new UserError(
          "Refunds open after the deadline, and only if the event stays below its minimum (or is cancelled).",
          409,
        );
      throw new UserError(
        "This event is GO, so commitments are not refundable.",
        409,
      );
    }
    const mint = new PublicKey(e.mint);
    const { programId, decimals } = await this.tokenInfo(mint);
    const token = getAssociatedTokenAddressSync(mint, wallet, false, programId);
    // A token account the wallet closed is re-created at its own cost, never the sponsor's.
    const hasToken = !!(await this.connection.getAccountInfo(token, "confirmed"));
    const pay = hasToken
      ? this.payerFor(wallet, `refund:${eventKey}`)
      : { feePayer: wallet, signers: [] as Keypair[] };
    const vault = this.vaultOf(mint, eventKey, programId);
    const ixs = hasToken
      ? []
      : [
          createAssociatedTokenAccountIdempotentInstruction(
            wallet,
            token,
            wallet,
            mint,
            programId,
          ),
        ];
    let total = 0n;
    if (c) {
      total += BigInt(c.amount);
      ixs.push(
        await this.methods
          .refund()
          .accountsPartial({
            participant: wallet,
            event: eventKey,
            commitment: this.commitPda(eventKey, wallet),
            rentPayer: c.rentPayer,
            mint,
            vault,
            participantToken: token,
            tokenProgram: programId,
          })
          .instruction()
          .then((ix: TransactionInstruction) => signedBy(ix, wallet)),
      );
    }
    if (p) {
      total += BigInt(p.amount);
      ixs.push(
        await this.methods
          .refundPledge()
          .accountsPartial({
            backer: wallet,
            event: eventKey,
            pledge: this.pledgePda(eventKey, wallet),
            rentPayer: p.rentPayer,
            mint,
            vault,
            backerToken: token,
            tokenProgram: programId,
          })
          .instruction()
          .then((ix: TransactionInstruction) => signedBy(ix, wallet)),
      );
    }
    return {
      e,
      ixs,
      ...pay,
      amount: formatUnits(total, decimals),
      what: c && p ? "ticket and pledge" : c ? "commitment" : "pledge",
    };
  }

  /** lib.rs check_in_open, with readable errors. */
  private async checkInChecks(
    e: EventView,
    eventKey: PublicKey,
    participant: PublicKey,
  ) {
    if (e.kind !== "deposit")
      throw new UserError("Check-in only exists for deposit events.", 409);
    if (e.cancelled)
      throw new UserError(
        "This event was cancelled; participants refund themselves.",
        409,
      );
    const c = await this.getCommitment(eventKey, participant);
    if (!c)
      throw new UserError("This wallet has not committed to the event.", 409);
    if (c.checkedIn) throw new UserError("Already checked in.", 409);
    if (!isGo(e))
      throw new UserError(
        "The event has not reached its minimum (not GO).",
        409,
      );
    const now = await this.chainNow();
    if (now < e.commitDeadline)
      throw new UserError(`${ERROR_MESSAGES.CheckInNotOpen}.`, 409);
    if (now > e.eventEnd)
      throw new UserError("The event is over; check-in is closed.", 409);
    return { c, now };
  }

  async buildCheckIn(
    eventKey: PublicKey,
    participant: PublicKey,
    organizer: PublicKey,
  ) {
    const e = await this.mustGetEvent(eventKey);
    if (e.organizer !== organizer.toBase58())
      throw new UserError(
        "Only the organizer's wallet can check people in. Scan this ticket with the organizer wallet.",
        403,
      );
    const { c } = await this.checkInChecks(e, eventKey, participant);
    const mint = new PublicKey(e.mint);
    const { programId, decimals } = await this.tokenInfo(mint);
    const token = getAssociatedTokenAddressSync(
      mint,
      participant,
      false,
      programId,
    );
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(
        organizer,
        token,
        participant,
        mint,
        programId,
      ),
      await this.methods
        .checkIn()
        .accountsPartial({
          organizer,
          event: eventKey,
          commitment: this.commitPda(eventKey, participant),
          mint,
          vault: this.vaultOf(mint, eventKey, programId),
          participantToken: token,
          tokenProgram: programId,
        })
        .instruction(),
    ];
    return {
      e,
      ixs,
      feePayer: organizer,
      signers: [] as Keypair[],
      amount: formatUnits(c.amount, decimals),
    };
  }

  /** The Ed25519 check must come right before check_in_with_pass. */
  async buildPassCheckIn(
    eventKey: PublicKey,
    participant: PublicKey,
    expiresAt: number,
    signature: Uint8Array,
  ) {
    const e = await this.mustGetEvent(eventKey);
    if (e.kind !== "deposit")
      throw new UserError("Door passes only exist for deposit events.", 409);
    if (!e.doorKey) throw new UserError(`${ERROR_MESSAGES.NoDoorScreen}.`, 409);
    const message = passMessage(eventKey, expiresAt);
    const doorKey = new PublicKey(e.doorKey);
    if (!verifyEd25519(doorKey, message, signature))
      throw new UserError(`${ERROR_MESSAGES.InvalidPass}.`, 400);
    const { c, now } = await this.checkInChecks(e, eventKey, participant);
    if (now > expiresAt)
      throw new UserError(`${ERROR_MESSAGES.PassExpired}.`, 409);
    if (expiresAt > now + MAX_PASS_SECS)
      throw new UserError(`${ERROR_MESSAGES.InvalidPass}.`, 400);
    const mint = new PublicKey(e.mint);
    const { programId, decimals } = await this.tokenInfo(mint);
    const pay = this.payerFor(participant, `pass:${eventKey}`);
    const ixs = [
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: doorKey.toBytes(),
        message,
        signature,
      }),
      await this.methods
        .checkInWithPass(new BN(expiresAt))
        .accountsPartial({
          participant,
          event: eventKey,
          commitment: this.commitPda(eventKey, participant),
          mint,
          vault: this.vaultOf(mint, eventKey, programId),
          participantToken: getAssociatedTokenAddressSync(
            mint,
            participant,
            false,
            programId,
          ),
          tokenProgram: programId,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction(),
    ];
    return { e, ixs, ...pay, amount: formatUnits(c.amount, decimals) };
  }

  async buildSetDoorKey(
    eventKey: PublicKey,
    organizer: PublicKey,
    doorKey: PublicKey,
  ) {
    const e = await this.mustGetEvent(eventKey);
    if (e.organizer !== organizer.toBase58())
      throw new UserError(
        "Only the organizer's wallet can register a door screen.",
        403,
      );
    if (e.kind !== "deposit")
      throw new UserError("Door screens only exist for deposit events.", 409);
    if ((await this.chainNow()) > e.eventEnd)
      throw new UserError("The event is over.", 409);
    const ix = await this.methods
      .setDoorKey(doorKey)
      .accountsPartial({ organizer, event: eventKey })
      .instruction();
    return { e, ixs: [ix], feePayer: organizer, signers: [] as Keypair[] };
  }

  async buildPayout(
    method: "withdraw" | "sweep",
    eventKey: PublicKey,
    organizer: PublicKey,
  ) {
    const e = await this.mustGetEvent(eventKey);
    if (e.organizer !== organizer.toBase58())
      throw new UserError("Only the organizer's wallet can do this.", 403);
    const wantKind: Kind = method === "withdraw" ? "ticket" : "deposit";
    if (e.kind !== wantKind)
      throw new UserError(
        method === "withdraw"
          ? "Deposit events are not withdrawn; use sweep after the event."
          : "Ticket events are not swept; use withdraw.",
        409,
      );
    if (e.cancelled)
      throw new UserError(
        "This event was cancelled; the money goes back to the participants.",
        409,
      );
    if (!isGo(e))
      throw new UserError(
        "The event has not reached its minimum (not GO).",
        409,
      );
    const now = await this.chainNow();
    if (method === "withdraw" && now < e.commitDeadline)
      throw new UserError(
        "Payout is available after the commit deadline.",
        409,
      );
    if (method === "sweep" && now <= e.eventEnd)
      throw new UserError(
        "No-show deposits can be swept only after the event ends.",
        409,
      );
    if (method === "sweep" && e.checkedIn === 0)
      throw new UserError(
        "Nobody was checked in, so participants take their deposits back instead.",
        409,
      );
    const vaultAmount = await this.vaultBalance(e);
    if (vaultAmount <= 0n)
      throw new UserError("The vault is empty; nothing to pay out.", 409);
    const mint = new PublicKey(e.mint);
    const { programId, decimals } = await this.tokenInfo(mint);
    const organizerToken = getAssociatedTokenAddressSync(
      mint,
      organizer,
      false,
      programId,
    );
    const treasuryToken = getAssociatedTokenAddressSync(
      mint,
      TREASURY,
      false,
      programId,
    );
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(
        organizer,
        organizerToken,
        organizer,
        mint,
        programId,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        organizer,
        treasuryToken,
        TREASURY,
        mint,
        programId,
      ),
      await this.methods[method]()
        .accountsPartial({
          organizer,
          event: eventKey,
          mint,
          vault: this.vaultOf(mint, eventKey, programId),
          organizerToken,
          tokenProgram: programId,
          treasury: TREASURY,
          treasuryToken,
        })
        .instruction(),
    ];
    const fee = feeOf(
      vaultAmount,
      method === "withdraw" ? TICKET_FEE_BPS : NO_SHOW_FEE_BPS,
    );
    return {
      e,
      ixs,
      feePayer: organizer,
      signers: [] as Keypair[],
      amount: formatUnits(vaultAmount, decimals),
      fee: formatUnits(fee, decimals),
      net: formatUnits(vaultAmount - fee, decimals),
    };
  }

  async buildCancel(eventKey: PublicKey, organizer: PublicKey) {
    const e = await this.mustGetEvent(eventKey);
    if (e.organizer !== organizer.toBase58())
      throw new UserError(
        "Only the organizer's wallet can cancel the event.",
        403,
      );
    if (e.cancelled)
      throw new UserError("This event is already cancelled.", 409);
    const now = await this.chainNow();
    if (now >= e.commitDeadline)
      throw new UserError(`${ERROR_MESSAGES.CancelTooLate}.`, 409);
    if (!cancellable(e, now))
      throw new UserError(
        "Money was already paid out or people checked in; the event can no longer be cancelled.",
        409,
      );
    const ix = await this.methods
      .cancelEvent()
      .accountsPartial({ organizer, event: eventKey })
      .instruction();
    return { e, ixs: [ix], feePayer: organizer, signers: [] as Keypair[] };
  }

  async buildCloseEvent(eventKey: PublicKey, organizer: PublicKey) {
    const e = await this.mustGetEvent(eventKey);
    if (e.organizer !== organizer.toBase58())
      throw new UserError("Only the organizer's wallet can close the event.", 403);
    const now = await this.chainNow();
    if (!refundable(e, now))
      throw new UserError(
        "Only a NO-GO or cancelled event can be closed, once everyone has their money back.",
        409,
      );
    if ((await this.vaultBalance(e)) > 0n)
      throw new UserError(
        "Not everyone has their money back yet; the event closes once the vault is empty.",
        409,
      );
    const mint = new PublicKey(e.mint);
    const { programId } = await this.tokenInfo(mint);
    const ix = await this.methods
      .closeEvent()
      .accountsPartial({
        organizer,
        event: eventKey,
        mint,
        vault: this.vaultOf(mint, eventKey, programId),
        tokenProgram: programId,
      })
      .instruction();
    return { e, ixs: [ix], feePayer: organizer, signers: [] as Keypair[] };
  }

  /** Refunds everyone on refundable events after a grace period (people can
   *  still press Refund themselves first). The sponsor pays the fees; tokens
   *  only go to each owner's token account. Returns the number refunded. */
  async crankRefunds(graceSecs = 3600, maxTx = 10): Promise<number> {
    if (!this.sponsor || !this.appMint) return 0;
    const now = await this.chainNow();
    let sent = 0;
    let refunded = 0;
    for (const e of await this.allEvents(this.appMint)) {
      if (sent >= maxTx) break;
      if (!refundable(e, now)) continue;
      const since = e.cancelled
        ? 0
        : isGo(e)
          ? e.eventEnd
          : e.commitDeadline;
      if (now < since + graceSecs) continue;
      const eventKey = new PublicKey(e.address);
      const mint = new PublicKey(e.mint);
      const { programId } = await this.tokenInfo(mint);
      const vault = this.vaultOf(mint, eventKey, programId);
      const claims = [
        ...(await this.commitments(eventKey)).map((c) => ({
          owner: new PublicKey(c.participant),
          rentPayer: new PublicKey(c.rentPayer),
          pledge: false,
        })),
        ...(e.kind === "ticket" ? await this.pledges(eventKey) : []).map(
          (p) => ({
            owner: new PublicKey(p.backer),
            rentPayer: new PublicKey(p.rentPayer),
            pledge: true,
          }),
        ),
      ];
      if (!claims.length) continue;
      const tokens = claims.map((c) =>
        getAssociatedTokenAddressSync(mint, c.owner, false, programId),
      );
      const infos = await this.connection.getMultipleAccountsInfo(
        tokens,
        "confirmed",
      );
      const ixs: TransactionInstruction[] = [];
      for (let i = 0; i < claims.length; i++) {
        if (!infos[i]) continue; // a closed token account: the owner refunds themselves
        const c = claims[i];
        ixs.push(
          c.pledge
            ? await this.methods
                .refundPledge()
                .accountsPartial({
                  backer: c.owner,
                  event: eventKey,
                  pledge: this.pledgePda(eventKey, c.owner),
                  rentPayer: c.rentPayer,
                  mint,
                  vault,
                  backerToken: tokens[i],
                  tokenProgram: programId,
                })
                .instruction()
            : await this.methods
                .refund()
                .accountsPartial({
                  participant: c.owner,
                  event: eventKey,
                  commitment: this.commitPda(eventKey, c.owner),
                  rentPayer: c.rentPayer,
                  mint,
                  vault,
                  participantToken: tokens[i],
                  tokenProgram: programId,
                })
                .instruction(),
        );
      }
      for (let i = 0; i < ixs.length && sent < maxTx; i += 5) {
        const batch = ixs.slice(i, i + 5);
        try {
          await sendAndConfirmTransaction(
            this.connection,
            new Transaction().add(...batch),
            [this.sponsor],
            { commitment: "confirmed" },
          );
          refunded += batch.length;
        } catch {
          /* try again next round */
        }
        sent++;
      }
    }
    return refunded;
  }

  /** Simulates first, so a failing tx throws a UserError with the program's message. */
  async finalize(b: Built): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: b.feePayer,
      blockhash,
      lastValidBlockHeight,
    }).add(...b.ixs);
    const sim = await this.connection.simulateTransaction(
      new VersionedTransaction(tx.compileMessage()),
      { sigVerify: false, commitment: "confirmed" },
    );
    if (sim.value.err)
      throw new UserError(
        this.explain(sim.value.err, sim.value.logs ?? []),
        422,
      );
    if (b.signers.length) tx.partialSign(...b.signers);
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }

  explain(err: unknown, logs: string[]): string {
    for (const l of logs) {
      const m = /Error Message: (.*)$/.exec(l);
      if (m) return m[1].replace(/\.$/, "") + ".";
    }
    for (const l of logs) {
      const m = /Error Code: (\w+)/.exec(l);
      if (m && ERROR_MESSAGES[m[1]]) return `${ERROR_MESSAGES[m[1]]}.`;
    }
    const custom = JSON.stringify(err).match(/"Custom":(\d+)/);
    if (custom && this.errorMessages.has(Number(custom[1])))
      return this.errorMessages.get(Number(custom[1]))! + ".";
    const all = logs.join("\n");
    if (/already in use/.test(all))
      return "This account already exists (already committed?).";
    if (/insufficient funds/i.test(all))
      return `Not enough ${this.symbol} in this wallet.`;
    if (
      /insufficient lamports/i.test(all) ||
      err === "InsufficientFundsForRent"
    )
      return "Not enough SOL in this wallet to pay for fees and rent.";
    if (err === "AccountNotFound")
      return "This wallet has no SOL on this cluster to pay the network fee.";
    return `The transaction would fail (${JSON.stringify(err)}).`;
  }

  /** Closes settled accounts whose rent the sponsor paid; returns the count. */
  async reclaimSponsoredRent(): Promise<number> {
    if (!this.sponsor) return 0;
    const me = this.sponsor.publicKey;
    const now = await this.chainNow();
    // rent_payer offsets: Commitment 8+32+32+8+1, Pledge 8+32+32+8.
    const kinds = [
      { name: "commitment", offset: 81, method: "closeCommitment" },
      { name: "pledge", offset: 80, method: "closePledge" },
    ] as const;
    let closed = 0;
    for (const k of kinds) {
      const accounts = await this.connection.getProgramAccounts(PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          { memcmp: this.program.coder.accounts.memcmp(k.name) },
          { memcmp: { offset: k.offset, bytes: me.toBase58() } },
        ],
      });
      for (const { pubkey, account } of accounts) {
        const a = this.program.coder.accounts.decode(k.name, account.data);
        const e = await this.getEvent(a.event);
        if (!e || !settledAt(e, now)) continue;
        try {
          const ix = await this.methods[k.method]()
            .accountsPartial({
              event: a.event,
              [k.name]: pubkey,
              rentPayer: me,
            })
            .instruction();
          const tx = new Transaction().add(ix);
          await sendAndConfirmTransaction(this.connection, tx, [this.sponsor], {
            commitment: "confirmed",
          });
          closed++;
        } catch {
          /* try again next round */
        }
      }
    }
    return closed;
  }
}

/** The program no longer requires the owner to sign a refund, but a refund the
 *  owner asks for stays signed by their wallet. */
function signedBy(ix: TransactionInstruction, wallet: PublicKey) {
  for (const k of ix.keys) if (k.pubkey.equals(wallet)) k.isSigner = true;
  return ix;
}

/** Mirrors the program's `settled`. */
export function settledAt(e: EventView, now: number): boolean {
  if (now <= e.eventEnd || e.cancelled) return false;
  const go =
    e.participants >= e.minParticipants &&
    BigInt(e.totalCommitted) >= BigInt(e.minAmount);
  if (!go) return false;
  return !(e.kind === "deposit" && e.checkedIn === 0);
}

/** Base units (integer) -> display string, exact: 5000000 @6 -> "5", 2500000 -> "2.50". */
export function formatUnits(amount: bigint | string, decimals: number): string {
  let v = BigInt(amount);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString();
  let frac = decimals
    ? (v % base).toString().padStart(decimals, "0").replace(/0+$/, "")
    : "";
  if (frac.length === 1) frac += "0";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function parseUnits(value: string, decimals: number): bigint | null {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0")
  );
}

/** Sliding limits for sponsored transactions: per wallet per hour and per day. */
export class SponsorLimits {
  private readonly perWallet = new Map<string, number[]>();
  private day: number[] = [];
  constructor(
    private readonly walletPerHour: number,
    private readonly perDay: number,
    private readonly walletWindowMs = 3_600_000,
  ) {}
  load(file: string) {
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as {
        day: number[];
        wallets: [string, number[]][];
      };
      this.day = d.day;
      for (const [k, v] of d.wallets) this.perWallet.set(k, v);
    } catch {
      /* nothing saved yet */
    }
  }
  save(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        `${file}.tmp`,
        JSON.stringify({ day: this.day, wallets: [...this.perWallet] }),
      );
      renameSync(`${file}.tmp`, file);
    } catch {
      /* limits still hold in memory */
    }
  }
  allow(wallet: string, now = Date.now()): boolean {
    const hour = now - this.walletWindowMs;
    this.day = this.day.filter((t) => t > now - 86_400_000);
    const mine = (this.perWallet.get(wallet) ?? []).filter((t) => t > hour);
    if (mine.length >= this.walletPerHour || this.day.length >= this.perDay) {
      this.perWallet.set(wallet, mine);
      return false;
    }
    mine.push(now);
    this.perWallet.set(wallet, mine);
    this.day.push(now);
    if (this.perWallet.size > 10_000) this.perWallet.clear();
    return true;
  }
}
