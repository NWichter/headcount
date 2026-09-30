// Needs a local validator with the program deployed (scripts/deploy-local.sh):
//   SOLANA_RPC_URL=http://127.0.0.1:8899 npm test
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createPrivateKey, sign as edSign } from "node:crypto";
import {
  createAccount,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const idl = JSON.parse(
  readFileSync(resolve("anchor/target/idl/headcount.json"), "utf8"),
);
const connection = new Connection(RPC, "confirmed");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures++;
};
const expectError = async (
  p: Promise<unknown>,
  code: string,
  label: string,
) => {
  try {
    await p;
    check(false, label, "succeeded unexpectedly");
  } catch (e) {
    const msg =
      String((e as Error).message ?? e) +
      JSON.stringify((e as { logs?: string[] }).logs ?? []);
    check(
      msg.includes(code),
      label,
      msg.includes(code) ? code : msg.slice(0, 160),
    );
  }
};
const sleepUntil = async (unix: number) => {
  for (;;) {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    if (t !== null && t >= unix) return;
    await new Promise((r) => setTimeout(r, 500));
  }
};
const chainNow = async () =>
  (await connection.getBlockTime(await connection.getSlot("confirmed")))!;

async function funded() {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(
    kp.publicKey,
    2 * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

const organizer = await funded();
const [p1, p2, p3, stranger] = await Promise.all([
  funded(),
  funded(),
  funded(),
  funded(),
]);
const program = new Program(
  idl,
  new AnchorProvider(connection, new Wallet(organizer), {
    commitment: "confirmed",
  }),
);
const programFor = (kp: Keypair) =>
  new Program(
    idl,
    new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }),
  );

const mint = await createMint(
  connection,
  organizer,
  organizer.publicKey,
  null,
  6,
);
const ata = async (owner: PublicKey) =>
  (await getOrCreateAssociatedTokenAccount(connection, organizer, mint, owner))
    .address;
for (const p of [p1, p2, p3])
  await mintTo(
    connection,
    organizer,
    mint,
    await ata(p.publicKey),
    organizer,
    100_000_000,
  );
const organizerAta = await ata(organizer.publicKey);
const TREASURY = new PublicKey("jSVWkBaMrzx6Vwxg3kLnjm4ACTLux2nFqmHLghrQF3B");
const treasuryAta = await ata(TREASURY);
const balance = async (a: PublicKey) =>
  Number((await getAccount(connection, a)).amount);

const eventPda = (id: number) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("event"),
      organizer.publicKey.toBuffer(),
      new BN(id).toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  )[0];
const commitPda = (event: PublicKey, who: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("commit"), event.toBuffer(), who.toBuffer()],
    program.programId,
  )[0];
const vaultOf = (event: PublicKey) =>
  getAssociatedTokenAddressSync(mint, event, true);

async function createEvent(
  id: number,
  kind: "ticket" | "deposit",
  price: number,
  min: number,
  deadlineIn: number,
  endIn: number,
  opts: { minAmount?: number; doorKey?: PublicKey } = {},
) {
  const now = await chainNow();
  const event = eventPda(id);
  await program.methods
    .createEvent(
      new BN(id),
      kind === "ticket" ? { ticket: {} } : { deposit: {} },
      new BN(price),
      min,
      0,
      new BN(opts.minAmount ?? 0),
      new BN(now + deadlineIn),
      new BN(now + endIn),
      opts.doorKey ?? PublicKey.default,
      `Test ${kind} ${id}`,
    )
    .accountsPartial({
      organizer: organizer.publicKey,
      event,
      mint,
      vault: vaultOf(event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { event, deadline: now + deadlineIn, end: now + endIn };
}
const commit = async (who: Keypair, event: PublicKey) =>
  programFor(who)
    .methods.commit()
    .accountsPartial({
      participant: who.publicKey,
      payer: who.publicKey,
      event,
      commitment: commitPda(event, who.publicKey),
      mint,
      participantToken: await ata(who.publicKey),
      vault: vaultOf(event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const payout = (
  method: "withdraw" | "sweep",
  event: PublicKey,
  signer = organizer,
) =>
  programFor(signer)
    .methods[method]()
    .accountsPartial({
      organizer: signer.publicKey,
      event,
      mint,
      vault: vaultOf(event),
      organizerToken: organizerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      treasury: TREASURY,
      treasuryToken: treasuryAta,
    })
    .rpc();
const closeEventTx = (event: PublicKey, signer = organizer) =>
  programFor(signer)
    .methods.closeEvent()
    .accountsPartial({
      organizer: signer.publicKey,
      event,
      mint,
      vault: vaultOf(event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const refund = async (who: Keypair, event: PublicKey) =>
  programFor(who)
    .methods.refund()
    .accountsPartial({
      participant: who.publicKey,
      event,
      commitment: commitPda(event, who.publicKey),
      rentPayer: who.publicKey,
      mint,
      vault: vaultOf(event),
      participantToken: await ata(who.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const checkIn = async (who: Keypair, event: PublicKey, signer = organizer) =>
  programFor(signer)
    .methods.checkIn()
    .accountsPartial({
      organizer: signer.publicKey,
      event,
      commitment: commitPda(event, who.publicKey),
      mint,
      vault: vaultOf(event),
      participantToken: await ata(who.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const fetchEvent = (e: PublicKey) => (program.account as any).event.fetch(e);
const pledgePda = (event: PublicKey, who: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("pledge"), event.toBuffer(), who.toBuffer()],
    program.programId,
  )[0];
const pledge = async (who: Keypair, event: PublicKey, amount: number) =>
  programFor(who)
    .methods.pledge(new BN(amount))
    .accountsPartial({
      backer: who.publicKey,
      payer: who.publicKey,
      event,
      pledge: pledgePda(event, who.publicKey),
      mint,
      backerToken: await ata(who.publicKey),
      vault: vaultOf(event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const refundPledge = async (who: Keypair, event: PublicKey) =>
  programFor(who)
    .methods.refundPledge()
    .accountsPartial({
      backer: who.publicKey,
      event,
      pledge: pledgePda(event, who.publicKey),
      rentPayer: who.publicKey,
      mint,
      vault: vaultOf(event),
      backerToken: await ata(who.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
const passMessage = (event: PublicKey, expiresAt: number) => {
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(BigInt(expiresAt));
  return Buffer.concat([
    Buffer.from("headcount-pass:v1"),
    event.toBuffer(),
    exp,
  ]);
};
async function checkInWithPass(
  who: Keypair,
  event: PublicKey,
  door: Keypair,
  expiresAt: number,
  opts: { withEd25519?: boolean; passEvent?: PublicKey } = {},
) {
  const message = passMessage(opts.passEvent ?? event, expiresAt);
  // PKCS#8 DER prefix around the raw 32-byte Ed25519 seed.
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(door.secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signature = edSign(null, message, key);
  const tx = new Transaction();
  if (opts.withEd25519 !== false)
    tx.add(
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: door.publicKey.toBytes(),
        message,
        signature,
      }),
    );
  tx.add(
    await programFor(who)
      .methods.checkInWithPass(new BN(expiresAt))
      .accountsPartial({
        participant: who.publicKey,
        event,
        commitment: commitPda(event, who.publicKey),
        mint,
        vault: vaultOf(event),
        participantToken: await ata(who.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction(),
  );
  return sendAndConfirmTransaction(connection, tx, [who], {
    commitment: "confirmed",
  });
}
const cancel = (event: PublicKey, signer = organizer) =>
  programFor(signer)
    .methods.cancelEvent()
    .accountsPartial({ organizer: signer.publicKey, event })
    .rpc();

try {
  const now = await chainNow();
  await expectError(
    program.methods
      .createEvent(
        new BN(90),
        { ticket: {} },
        new BN(0),
        1,
        0,
        new BN(0),
        new BN(now + 60),
        new BN(now + 120),
        PublicKey.default,
        "x",
      )
      .accountsPartial({
        organizer: organizer.publicKey,
        event: eventPda(90),
        mint,
        vault: vaultOf(eventPda(90)),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(),
    "InvalidPrice",
    "price 0 is rejected",
  );
  await expectError(
    program.methods
      .createEvent(
        new BN(91),
        { ticket: {} },
        new BN(1),
        1,
        0,
        new BN(0),
        new BN(now - 5),
        new BN(now + 120),
        PublicKey.default,
        "x",
      )
      .accountsPartial({
        organizer: organizer.publicKey,
        event: eventPda(91),
        mint,
        vault: vaultOf(eventPda(91)),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(),
    "InvalidDeadline",
    "deadline in the past is rejected",
  );

  await expectError(
    program.methods
      .createEvent(
        new BN(92),
        { ticket: {} },
        new BN(1),
        1,
        0,
        new BN(0),
        new BN(now + 181 * 86400),
        new BN(now + 182 * 86400),
        PublicKey.default,
        "x",
      )
      .accountsPartial({
        organizer: organizer.publicKey,
        event: eventPda(92),
        mint,
        vault: vaultOf(eventPda(92)),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc(),
    "InvalidDeadline",
    "deadline more than 180 days out is rejected",
  );
  const mint22 = await createMint(
    connection,
    organizer,
    organizer.publicKey,
    null,
    6,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  try {
    await program.methods
      .createEvent(
        new BN(93),
        { ticket: {} },
        new BN(1),
        1,
        0,
        new BN(0),
        new BN(now + 60),
        new BN(now + 120),
        PublicKey.default,
        "x",
      )
      .accountsPartial({
        organizer: organizer.publicKey,
        event: eventPda(93),
        mint: mint22,
        vault: getAssociatedTokenAddressSync(
          mint22,
          eventPda(93),
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    check(false, "Token-2022 mints are rejected", "succeeded unexpectedly");
  } catch (e) {
    const msg =
      String((e as Error).message) +
      JSON.stringify((e as { logs?: string[] }).logs ?? []);
    check(
      msg.includes("UnsupportedMint"),
      "Token-2022 mints are rejected (no fees, hooks or delegates on the vault)",
      msg.includes("UnsupportedMint") ? "UnsupportedMint" : msg.slice(0, 160),
    );
  }

  const go = await createEvent(1, "ticket", 5_000_000, 2, 12, 60);
  await commit(p1, go.event);
  check(
    (await fetchEvent(go.event)).participants === 1,
    "first commitment counted (1 of 2)",
  );
  await expectError(
    payout("withdraw", go.event),
    "NotGo",
    "organizer cannot withdraw below the minimum",
  );
  await expectError(
    commit(p1, go.event),
    "already in use",
    "the same person cannot commit twice",
  );
  await commit(p2, go.event);
  check((await fetchEvent(go.event)).participants === 2, "GO at 2 of 2");
  await expectError(
    payout("withdraw", go.event),
    "DeadlineNotReached",
    "GO, but no payout before the deadline (organizer could still cancel)",
  );
  await commit(p3, go.event);
  const before = await balance(organizerAta);
  await sleepUntil(go.deadline);
  await expectError(
    payout("withdraw", go.event, stranger),
    "ConstraintHasOne",
    "only the organizer can withdraw",
  );
  const treasuryBefore = await balance(treasuryAta);
  await payout("withdraw", go.event);
  check(
    (await balance(organizerAta)) - before === 14_700_000 &&
      (await balance(treasuryAta)) - treasuryBefore === 300_000,
    "after the deadline the organizer withdraws 3 tickets: 14.70 USDC, 0.30 (2 %) to the treasury",
  );
  await expectError(
    programFor(organizer)
      .methods.withdraw()
      .accountsPartial({
        organizer: organizer.publicKey,
        event: go.event,
        mint,
        vault: vaultOf(go.event),
        organizerToken: organizerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        treasury: stranger.publicKey,
        treasuryToken: await ata(stranger.publicKey),
      })
      .rpc(),
    "WrongTreasury",
    "the fee can only go to the protocol treasury",
  );
  await expectError(
    cancel(go.event),
    "CancelTooLate",
    "after the deadline a GO is final: no cancelling",
  );
  await expectError(
    refund(p1, go.event),
    "EventIsGo",
    "no refunds once the event is GO",
  );
  await expectError(
    commit(stranger, go.event),
    "DeadlinePassed",
    "no commitments after the deadline",
  );

  const nogo = await createEvent(2, "ticket", 7_000_000, 3, 8, 60);
  const p1Before = await balance(await ata(p1.publicKey));
  await commit(p1, nogo.event);
  await expectError(
    refund(p1, nogo.event),
    "DeadlineNotReached",
    "no refund before the deadline",
  );
  await sleepUntil(nogo.deadline);
  await expectError(
    commit(p2, nogo.event),
    "DeadlinePassed",
    "commit after the deadline is rejected",
  );
  await expectError(
    payout("withdraw", nogo.event),
    "NotGo",
    "organizer gets nothing from a NO-GO event",
  );
  await refund(p1, nogo.event);
  check(
    (await balance(await ata(p1.publicKey))) === p1Before,
    "NO-GO: participant refunds herself, without the organizer",
  );
  check(
    (await connection.getAccountInfo(commitPda(nogo.event, p1.publicKey))) ===
      null,
    "commitment account closed, rent returned",
  );

  const off = await createEvent(4, "ticket", 3_000_000, 5, 60, 120);
  const p2Before = await balance(await ata(p2.publicKey));
  await commit(p2, off.event);
  await expectError(
    cancel(off.event, stranger),
    "ConstraintHasOne",
    "only the organizer can cancel",
  );
  await cancel(off.event);
  check(
    (await fetchEvent(off.event)).cancelled === true,
    "organizer cancels the event",
  );
  await expectError(
    commit(p3, off.event),
    "Cancelled",
    "no commitments to a cancelled event",
  );
  await expectError(
    payout("withdraw", off.event),
    "Cancelled",
    "no payout from a cancelled event",
  );
  await refund(p2, off.event);
  check(
    (await balance(await ata(p2.publicKey))) === p2Before,
    "cancelled: refund right away, no need to wait for the deadline",
  );

  const dep = await createEvent(3, "deposit", 2_000_000, 2, 6, 22);
  await commit(p1, dep.event);
  await commit(p2, dep.event);
  await expectError(
    payout("withdraw", dep.event),
    "WrongKind",
    "deposits cannot be withdrawn like tickets",
  );
  await expectError(
    checkIn(p1, dep.event),
    "CheckInNotOpen",
    "no check-in before the deadline (no early friendly check-ins)",
  );
  await sleepUntil(dep.deadline);
  const p1Dep = await balance(await ata(p1.publicKey));
  await checkIn(p1, dep.event);
  check(
    (await balance(await ata(p1.publicKey))) - p1Dep === 2_000_000,
    "check-in at the door returns the deposit",
  );
  await expectError(
    checkIn(p1, dep.event),
    "AlreadyCheckedIn",
    "a participant is checked in only once",
  );
  await expectError(
    cancel(dep.event),
    "CancelTooLate",
    "cannot cancel once the door is open",
  );
  await expectError(
    checkIn(p2, dep.event, stranger),
    "ConstraintHasOne",
    "only the organizer can check people in",
  );
  await expectError(
    payout("sweep", dep.event),
    "EventNotOver",
    "no sweep before the event is over",
  );
  await sleepUntil(dep.end + 1);
  await expectError(
    checkIn(p2, dep.event),
    "EventOver",
    "no check-in after the event",
  );
  const orgBefore = await balance(organizerAta);
  const treasuryBeforeSweep = await balance(treasuryAta);
  await payout("sweep", dep.event);
  check(
    (await balance(organizerAta)) - orgBefore === 1_900_000 &&
      (await balance(treasuryAta)) - treasuryBeforeSweep === 100_000,
    "no-show deposit goes to the organizer (pizza): 1.90 USDC, 0.10 (5 %) to the treasury",
  );
  const e = await fetchEvent(dep.event);
  check(
    e.participants === 2 && e.checkedIn === 1,
    "event counts 2 committed, 1 checked in",
  );

  const ghost = await createEvent(5, "deposit", 2_000_000, 2, 5, 9);
  const p3Before = await balance(await ata(p3.publicKey));
  await commit(p2, ghost.event);
  await commit(p3, ghost.event);
  await sleepUntil(ghost.end + 1);
  await expectError(
    payout("sweep", ghost.event),
    "NobodyCheckedIn",
    "nobody checked in: the organizer cannot sweep the deposits",
  );
  await refund(p3, ghost.event);
  check(
    (await balance(await ata(p3.publicKey))) === p3Before,
    "nobody checked in: participants take their deposits back",
  );

  const [backer, sponsor] = await Promise.all([funded(), funded()]);
  await mintTo(
    connection,
    organizer,
    mint,
    await ata(backer.publicKey),
    organizer,
    100_000_000,
  );
  await expectError(
    createEvent(10, "deposit", 2_000_000, 2, 60, 120, {
      minAmount: 50_000_000,
    }),
    "BudgetOnlyForTickets",
    "a budget goal is only for ticket events",
  );
  // Room costs 30 USDC: 2 people at 5 USDC bring 10, a backer adds 20.
  const fund = await createEvent(11, "ticket", 5_000_000, 2, 12, 60, {
    minAmount: 30_000_000,
  });
  await commit(p1, fund.event);
  await commit(p2, fund.event);
  let fe = await fetchEvent(fund.event);
  check(
    fe.participants === 2 && Number(fe.totalCommitted) === 10_000_000,
    "headcount reached but budget missing: still not GO",
    `${Number(fe.totalCommitted) / 1e6} of 30 USDC`,
  );
  await pledge(backer, fund.event, 20_000_000);
  fe = await fetchEvent(fund.event);
  check(
    fe.participants === 2 &&
      fe.backers === 1 &&
      Number(fe.totalCommitted) === 30_000_000,
    "backer closes the money gap without taking a seat",
  );
  const orgBeforeFund = await balance(organizerAta);
  await sleepUntil(fund.deadline);
  await payout("withdraw", fund.event);
  check(
    (await balance(organizerAta)) - orgBeforeFund === 29_400_000,
    "GO: organizer receives tickets and pledges (30 USDC minus the 2 % fee)",
  );

  const crowdless = await createEvent(12, "ticket", 5_000_000, 3, 10, 60, {
    minAmount: 10_000_000,
  });
  const backerBefore = await balance(await ata(backer.publicKey));
  await commit(p1, crowdless.event);
  await pledge(backer, crowdless.event, 50_000_000);
  await sleepUntil(crowdless.deadline);
  await expectError(
    payout("withdraw", crowdless.event),
    "NotGo",
    "money is there but the headcount is not: NO-GO",
  );
  await refundPledge(backer, crowdless.event);
  check(
    (await balance(await ata(backer.publicKey))) === backerBefore,
    "NO-GO: the backer refunds their pledge themselves",
  );
  check(
    (await connection.getAccountInfo(
      pledgePda(crowdless.event, backer.publicKey),
    )) === null,
    "pledge account closed, rent back to its payer",
  );
  await expectError(
    pledge(backer, dep.event, 1_000_000),
    "WrongKind",
    "no pledges on deposit events",
  );

  const walletNoSol = Keypair.generate();
  await mintTo(
    connection,
    organizer,
    mint,
    await ata(walletNoSol.publicKey),
    organizer,
    10_000_000,
  );
  const sponsored = await createEvent(13, "ticket", 4_000_000, 5, 8, 60);
  const sponsorBefore = await connection.getBalance(sponsor.publicKey);
  const ix = await program.methods
    .commit()
    .accountsPartial({
      participant: walletNoSol.publicKey,
      payer: sponsor.publicKey,
      event: sponsored.event,
      commitment: commitPda(sponsored.event, walletNoSol.publicKey),
      mint,
      participantToken: await ata(walletNoSol.publicKey),
      vault: vaultOf(sponsored.event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const sponsoredTx = new Transaction().add(ix);
  sponsoredTx.feePayer = sponsor.publicKey;
  await sendAndConfirmTransaction(
    connection,
    sponsoredTx,
    [sponsor, walletNoSol],
    {
      commitment: "confirmed",
    },
  );
  check(
    (await connection.getBalance(walletNoSol.publicKey)) === 0 &&
      (await fetchEvent(sponsored.event)).participants === 1,
    "commit works from a wallet with 0 SOL (the app pays fees and rent)",
  );
  await sleepUntil(sponsored.deadline);
  const refundIx = await program.methods
    .refund()
    .accountsPartial({
      participant: walletNoSol.publicKey,
      event: sponsored.event,
      commitment: commitPda(sponsored.event, walletNoSol.publicKey),
      rentPayer: sponsor.publicKey,
      mint,
      vault: vaultOf(sponsored.event),
      participantToken: await ata(walletNoSol.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const refundTx = new Transaction().add(refundIx);
  refundTx.feePayer = sponsor.publicKey;
  await sendAndConfirmTransaction(
    connection,
    refundTx,
    [sponsor, walletNoSol],
    {
      commitment: "confirmed",
    },
  );
  const sponsorAfter = await connection.getBalance(sponsor.publicKey);
  check(
    sponsorBefore - sponsorAfter <= 20_000 &&
      (await balance(await ata(walletNoSol.publicKey))) === 10_000_000,
    "NO-GO refund: USDC back to the participant, account rent back to the app",
    `app spent ${sponsorBefore - sponsorAfter} lamports in fees`,
  );
  await expectError(
    (async () => {
      const bad = await program.methods
        .refund()
        .accountsPartial({
          participant: p3.publicKey,
          event: go.event,
          commitment: commitPda(go.event, p3.publicKey),
          rentPayer: stranger.publicKey,
          mint,
          vault: vaultOf(go.event),
          participantToken: await ata(p3.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      return sendAndConfirmTransaction(connection, new Transaction().add(bad), [
        p3,
      ]);
    })(),
    "ConstraintHasOne",
    "rent can only go back to whoever paid it",
  );

  const door = Keypair.generate();
  const party = await createEvent(14, "deposit", 3_000_000, 2, 8, 90, {
    doorKey: door.publicKey,
  });
  const noScreen = await createEvent(15, "deposit", 3_000_000, 1, 8, 90);
  await commit(p1, party.event);
  await commit(p2, party.event);
  await commit(p3, party.event);
  await commit(p1, noScreen.event);
  let t = await chainNow();
  await expectError(
    checkInWithPass(p1, party.event, door, t + 60),
    "CheckInNotOpen",
    "the door opens at the deadline, not before",
  );
  await sleepUntil(party.deadline);
  t = await chainNow();
  const p1Party = await balance(await ata(p1.publicKey));
  await checkInWithPass(p1, party.event, door, t + 60);
  check(
    (await balance(await ata(p1.publicKey))) - p1Party === 3_000_000,
    "attendee scans the door pass: deposit back, no organizer needed",
  );
  await expectError(
    checkInWithPass(p1, party.event, door, t + 60),
    "AlreadyCheckedIn",
    "a pass checks each person in once",
  );
  await expectError(
    checkInWithPass(p2, party.event, Keypair.generate(), t + 60),
    "InvalidPass",
    "a pass signed by any other key is rejected",
  );
  await expectError(
    checkInWithPass(p2, party.event, door, t + 60, { withEd25519: false }),
    "InvalidPass",
    "no signature check in the transaction: rejected",
  );
  await expectError(
    checkInWithPass(p2, party.event, door, t + 60, {
      passEvent: noScreen.event,
    }),
    "InvalidPass",
    "a pass for another event is rejected",
  );
  await expectError(
    checkInWithPass(p2, party.event, door, t - 5),
    "PassExpired",
    "an expired pass (someone sent a screenshot home) is rejected",
  );
  await expectError(
    checkInWithPass(p2, party.event, door, t + 3600),
    "InvalidPass",
    "a pass valid for more than two minutes is rejected",
  );
  await sleepUntil(noScreen.deadline);
  t = await chainNow();
  await expectError(
    checkInWithPass(p1, noScreen.event, door, t + 60),
    "NoDoorScreen",
    "no door screen registered: self check-in not possible",
  );
  const door2 = Keypair.generate();
  await program.methods
    .setDoorKey(door2.publicKey)
    .accountsPartial({ organizer: organizer.publicKey, event: party.event })
    .rpc();
  t = await chainNow();
  await expectError(
    checkInWithPass(p2, party.event, door, t + 60),
    "InvalidPass",
    "after rotating the door key, old passes stop working",
  );
  await checkInWithPass(p2, party.event, door2, t + 60);
  check(
    (await fetchEvent(party.event)).checkedIn === 2,
    "the new door screen checks the next attendee in",
  );
  await expectError(
    programFor(stranger)
      .methods.setDoorKey(stranger.publicKey)
      .accountsPartial({ organizer: stranger.publicKey, event: party.event })
      .rpc(),
    "ConstraintHasOne",
    "only the organizer can register a door screen",
  );

  const closeCommitment = (
    event: PublicKey,
    who: PublicKey,
    rentPayer: PublicKey,
  ) =>
    programFor(stranger)
      .methods.closeCommitment()
      .accountsPartial({ event, commitment: commitPda(event, who), rentPayer })
      .rpc();
  const closePledgeIx = (
    event: PublicKey,
    who: PublicKey,
    rentPayer: PublicKey,
  ) =>
    programFor(stranger)
      .methods.closePledge()
      .accountsPartial({ event, pledge: pledgePda(event, who), rentPayer })
      .rpc();
  const settledGo = await createEvent(16, "ticket", 2_000_000, 2, 6, 12, {
    minAmount: 5_000_000,
  });
  const viaSponsor = await program.methods
    .commit()
    .accountsPartial({
      participant: p1.publicKey,
      payer: sponsor.publicKey,
      event: settledGo.event,
      commitment: commitPda(settledGo.event, p1.publicKey),
      mint,
      participantToken: await ata(p1.publicKey),
      vault: vaultOf(settledGo.event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const viaTx = new Transaction().add(viaSponsor);
  viaTx.feePayer = sponsor.publicKey;
  await sendAndConfirmTransaction(connection, viaTx, [sponsor, p1], {
    commitment: "confirmed",
  });
  await commit(p2, settledGo.event);
  await pledge(backer, settledGo.event, 1_000_000);
  await expectError(
    closeCommitment(settledGo.event, p1.publicKey, sponsor.publicKey),
    "EventNotOver",
    "accounts stay open until the event is over",
  );
  const unsettled = await createEvent(17, "ticket", 2_000_000, 5, 6, 12);
  await commit(p3, unsettled.event);
  await sleepUntil(settledGo.end + 1);
  const sponsorBeforeClose = await connection.getBalance(sponsor.publicKey);
  await closeCommitment(settledGo.event, p1.publicKey, sponsor.publicKey);
  check(
    (await connection.getAccountInfo(
      commitPda(settledGo.event, p1.publicKey),
    )) === null &&
      (await connection.getBalance(sponsor.publicKey)) > sponsorBeforeClose,
    "settled GO event: anyone closes the commitment, rent back to the sponsoring app",
  );
  await expectError(
    closeCommitment(settledGo.event, p2.publicKey, stranger.publicKey),
    "ConstraintHasOne",
    "closing sends rent only to whoever paid it",
  );
  await closePledgeIx(settledGo.event, backer.publicKey, backer.publicKey);
  check(
    (await connection.getAccountInfo(
      pledgePda(settledGo.event, backer.publicKey),
    )) === null,
    "settled GO event: pledge account closed, rent back to its payer",
  );
  await sleepUntil(unsettled.end + 1);
  await expectError(
    closeCommitment(unsettled.event, p3.publicKey, p3.publicKey),
    "StillRefundable",
    "NO-GO event: accounts stay until people refund",
  );

  // Anyone may trigger a refund; the tokens only reach the owner's token account.
  const crank = await createEvent(20, "ticket", 4_000_000, 3, 12, 60);
  await commit(p1, crank.event);
  await pledge(backer, crank.event, 2_000_000);
  const refundBy = (by: Keypair, owner: PublicKey, token: PublicKey) =>
    programFor(by)
      .methods.refund()
      .accountsPartial({
        participant: owner,
        event: crank.event,
        commitment: commitPda(crank.event, owner),
        rentPayer: owner,
        mint,
        vault: vaultOf(crank.event),
        participantToken: token,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  await expectError(
    refundBy(stranger, p1.publicKey, await ata(p1.publicKey)),
    "DeadlineNotReached",
    "no refund before the deadline, whoever triggers it",
  );
  await sleepUntil(crank.deadline);
  await expectError(
    refundBy(stranger, p1.publicKey, await ata(stranger.publicKey)),
    "ConstraintTokenOwner",
    "a refund cannot be redirected to someone else's token account",
  );
  const sideAccount = await createAccount(
    connection,
    p1,
    mint,
    p1.publicKey,
    Keypair.generate(),
  );
  await expectError(
    refundBy(stranger, p1.publicKey, sideAccount),
    "ConstraintAssociated",
    "a refund only goes to the owner's main token account",
  );
  await expectError(
    closeEventTx(crank.event),
    "VaultNotEmpty",
    "an event cannot be closed while refunds are open",
  );
  const p1BeforeCrank = await balance(await ata(p1.publicKey));
  await refundBy(stranger, p1.publicKey, await ata(p1.publicKey));
  check(
    (await balance(await ata(p1.publicKey))) - p1BeforeCrank === 4_000_000 &&
      (await connection.getAccountInfo(commitPda(crank.event, p1.publicKey))) ===
        null,
    "NO-GO: anyone triggers the refund; the money lands in the participant's own account",
  );
  await expectError(
    refundBy(stranger, p1.publicKey, await ata(p1.publicKey)),
    "AccountNotInitialized",
    "a refund cannot be triggered twice",
  );
  const backerBeforeCrank = await balance(await ata(backer.publicKey));
  await programFor(stranger)
    .methods.refundPledge()
    .accountsPartial({
      backer: backer.publicKey,
      event: crank.event,
      pledge: pledgePda(crank.event, backer.publicKey),
      rentPayer: backer.publicKey,
      mint,
      vault: vaultOf(crank.event),
      backerToken: await ata(backer.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  check(
    (await balance(await ata(backer.publicKey))) - backerBeforeCrank ===
      2_000_000,
    "NO-GO: anyone triggers the backer's refund too",
  );
  await expectError(
    closeEventTx(crank.event, stranger),
    "ConstraintHasOne",
    "only the organizer can close an event",
  );
  const lamportsBeforeClose = await connection.getBalance(organizer.publicKey);
  await closeEventTx(crank.event);
  check(
    (await connection.getAccountInfo(crank.event)) === null &&
      (await connection.getAccountInfo(vaultOf(crank.event))) === null &&
      (await connection.getBalance(organizer.publicKey)) > lamportsBeforeClose,
    "everyone refunded: the organizer closes the event and its vault, rent comes back",
  );
  await expectError(
    closeEventTx(go.event),
    "EventIsGo",
    "a GO event can never be closed",
  );
} catch (e) {
  console.error(e);
  failures++;
} finally {
  console.log(
    failures ? `\n${failures} check(s) failed` : "\nall checks passed",
  );
  process.exit(failures ? 1 : 0);
}
