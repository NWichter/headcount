// Seeds a local validator with a believable demo: a test USDC mint, an
// organizer, a crowd of participant wallets, a backer, and events in every
// state (open, GO, NO-GO, budget half-filled by a backer, a deposit event
// with a registered door screen and people checked in with door passes).
// Prints the MINT for `npm run app` and the door-screen link.
//   SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx scripts/demo-seed.ts
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const bs58 = anchor.utils.bytes.bs58;
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
// Public RPCs (devnet) rate-limit hard: one request at a time with a small
// gap, and a patient retry on 429.
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
const gapMs = /127\.0\.0\.1|localhost/.test(RPC) ? 0 : 150;
const throttledFetch: typeof fetch = (input, init) => {
  const run = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      const res = await fetch(input, init);
      if (res.status !== 429 || attempt >= 8) return res;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
};
const connection = new Connection(RPC, {
  commitment: "confirmed",
  fetch: throttledFetch,
  disableRetryOnRateLimit: true,
});
const idl = JSON.parse(
  readFileSync(resolve("anchor/target/idl/headcount.json"), "utf8"),
);
const USDC = 1_000_000;

// Local validator: airdrops. Devnet (airdrops are rate-limited): set
// FUNDER_KEYPAIR to a funded keypair file; each wallet gets a small transfer.
const funder = process.env.FUNDER_KEYPAIR
  ? Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(readFileSync(process.env.FUNDER_KEYPAIR, "utf8")),
      ),
    )
  : undefined;
// Keys are saved before any money moves, so an interrupted run resumes with
// the same wallets instead of stranding their SOL.
const keysFile = process.env.DEMO_KEYS;
const savedKeys: number[][] =
  keysFile && existsSync(keysFile)
    ? JSON.parse(readFileSync(keysFile, "utf8"))
    : [];
let keyIndex = 0;
async function funded(sol = 0.02) {
  const i = keyIndex++;
  const kp = savedKeys[i]
    ? Keypair.fromSecretKey(Uint8Array.from(savedKeys[i]))
    : Keypair.generate();
  if (keysFile && !savedKeys[i]) {
    savedKeys[i] = Array.from(kp.secretKey);
    writeFileSync(keysFile, JSON.stringify(savedKeys));
  }
  const need = Math.round(sol * LAMPORTS_PER_SOL);
  if (funder && (await connection.getBalance(kp.publicKey)) >= need * 0.9)
    return kp;
  if (funder) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: kp.publicKey,
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      ),
      [funder],
      { commitment: "confirmed" },
    );
    return kp;
  }
  const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  return kp;
}
const programFor = (kp: Keypair) =>
  new Program(
    idl,
    new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }),
  );
const chainNow = async () =>
  (await connection.getBlockTime(await connection.getSlot("confirmed")))!;

const organizer = await funded(0.25);
const backer = await funded();
// Sequential: parallel transfers from one funder can collide on devnet.
const crowd: Keypair[] = [];
for (let i = 0; i < 14; i++) crowd.push(await funded());
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
for (const p of [...crowd, backer])
  await mintTo(
    connection,
    organizer,
    mint,
    await ata(p.publicKey),
    organizer,
    200 * USDC,
  );
await ata(organizer.publicKey);

const program = programFor(organizer);
const eventPda = (id: bigint) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("event"),
      organizer.publicKey.toBuffer(),
      new BN(id.toString()).toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  )[0];
const commitPda = (event: PublicKey, who: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("commit"), event.toBuffer(), who.toBuffer()],
    program.programId,
  )[0];
const pledgePda = (event: PublicKey, who: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("pledge"), event.toBuffer(), who.toBuffer()],
    program.programId,
  )[0];
const vaultOf = (event: PublicKey) =>
  getAssociatedTokenAddressSync(mint, event, true);
let nextId = BigInt(Date.now()) * 1000n;

async function create(
  title: string,
  kind: "ticket" | "deposit",
  price: number,
  min: number,
  max: number,
  deadlineIn: number,
  endIn: number,
  opts: { budget?: number; doorKey?: PublicKey } = {},
) {
  const now = await chainNow();
  const id = nextId++;
  const event = eventPda(id);
  await program.methods
    .createEvent(
      new BN(id.toString()),
      kind === "ticket" ? { ticket: {} } : { deposit: {} },
      new BN(price * USDC),
      min,
      max,
      new BN((opts.budget ?? 0) * USDC),
      new BN(now + deadlineIn),
      new BN(now + endIn),
      opts.doorKey ?? PublicKey.default,
      title,
    )
    .accountsPartial({
      organizer: organizer.publicKey,
      event,
      mint,
      vault: vaultOf(event),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return event;
}
async function commit(event: PublicKey, who: Keypair[]) {
  for (const p of who)
    await programFor(p)
      .methods.commit()
      .accountsPartial({
        participant: p.publicKey,
        payer: p.publicKey,
        event,
        commitment: commitPda(event, p.publicKey),
        mint,
        participantToken: await ata(p.publicKey),
        vault: vaultOf(event),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
}
async function pledge(event: PublicKey, who: Keypair, amount: number) {
  await programFor(who)
    .methods.pledge(new BN(amount * USDC))
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
}
/** Self check-in with a door pass signed by the door key (as the door screen does). */
async function checkInWithPass(event: PublicKey, who: Keypair, door: Keypair) {
  const expiresAt = (await chainNow()) + 90;
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(BigInt(expiresAt));
  const message = Buffer.concat([
    Buffer.from("headcount-pass:v1"),
    event.toBuffer(),
    exp,
  ]);
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(door.secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const tx = new Transaction().add(
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: door.publicKey.toBytes(),
      message,
      signature: edSign(null, message, key),
    }),
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
  await sendAndConfirmTransaction(connection, tx, [who], {
    commitment: "confirmed",
  });
}
async function checkIn(event: PublicKey, who: Keypair[]) {
  for (const p of who)
    await program.methods
      .checkIn()
      .accountsPartial({
        organizer: organizer.publicKey,
        event,
        commitment: commitPda(event, p.publicKey),
        mint,
        vault: vaultOf(event),
        participantToken: await ata(p.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
}

const DAY = 86_400;
// Open events stay open for weeks: people try the demo long after seeding.
// NO-GO first: its deadline has to pass while the others are seeded.
const breakfast = await create(
  "Founders Breakfast at WHU",
  "ticket",
  12,
  8,
  20,
  25,
  DAY,
);
await commit(breakfast, crowd.slice(0, 3));

// Budget goal: 8 people and 150 USDC; 6 tickets (60) + a 40 USDC backer.
const pizza = await create(
  "Hackathon Pizza Night",
  "ticket",
  10,
  8,
  40,
  30 * DAY,
  30 * DAY + 4 * 3600,
  { budget: 150 },
);
await commit(pizza, crowd.slice(6, 12));
await pledge(pizza, backer, 40);

const rooftop = await create(
  "Rooftop Coding Night",
  "deposit",
  5,
  10,
  30,
  21 * DAY,
  21 * DAY + 5 * 3600,
);
await commit(rooftop, crowd.slice(0, 7));

const bus = await create(
  "Bus to Solana Breakpoint",
  "ticket",
  25,
  8,
  12,
  25 * DAY,
  29 * DAY,
);
await commit(bus, crowd.slice(2, 12));

// Deposit event with a door screen: the door key is registered at creation
// and saved to data/demo.json, so /e/<study>/door#key=... shows live passes.
const door = Keypair.generate();
const study = await create(
  "Anchor Study Group #4",
  "deposit",
  3,
  5,
  15,
  60,
  45 * DAY,
  { doorKey: door.publicKey },
);
await commit(study, crowd.slice(4, 13));

const hike = await create(
  "Sunday Hike, Rheingau",
  "deposit",
  5,
  6,
  20,
  28 * DAY,
  28 * DAY + 8 * 3600,
);
await commit(hike, crowd.slice(9, 11));

// Study group: the deadline passes (GO), then people arrive at the door:
// four scan the door pass themselves, one is checked in by hand.
const t = (await chainNow()) + 62;
while ((await chainNow()) < t) await new Promise((r) => setTimeout(r, 1000));
for (const p of crowd.slice(4, 8)) await checkInWithPass(study, p, door);
await checkIn(study, crowd.slice(8, 9));

mkdirSync("data", { recursive: true });
const out = {
  MINT: mint.toBase58(),
  organizer: Array.from(organizer.secretKey),
  events: {
    pizza: pizza.toBase58(),
    rooftop: rooftop.toBase58(),
    bus: bus.toBase58(),
    breakfast: breakfast.toBase58(),
    study: study.toBase58(),
    hike: hike.toBase58(),
  },
  participant: crowd[9].publicKey.toBase58(),
  backer: backer.publicKey.toBase58(),
  // Door screen of the study group: open /e/<study>/door#key=<doorSecret>.
  doorSecret: bs58.encode(door.secretKey),
  doorKey: door.publicKey.toBase58(),
};
const outFile = process.env.DEMO_OUT ?? "data/demo.json";
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`MINT=${out.MINT}`);
console.log(JSON.stringify(out.events, null, 2));
console.log(`Door screen: /e/${out.events.study}/door#key=${out.doorSecret}`);
process.exit(0);
