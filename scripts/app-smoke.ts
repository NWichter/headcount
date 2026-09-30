// Drives the app's Solana Pay endpoints like a wallet, against a local validator:
//   SOLANA_RPC_URL=http://127.0.0.1:8899 npm run app:smoke
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";

const bs58 = anchor.utils.bytes.bs58;
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC))
  throw new Error(
    "app-smoke runs against a local validator only (SOLANA_RPC_URL).",
  );
const PROGRAM_ID = new PublicKey(
  "9NeaXRkbU4Jxsmh2aJyN74gxRoAR7fYupV68FEzDH6KH",
);
const IDL = resolve("anchor/target/idl/headcount.json");
const connection = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures++;
};

// Few wallets, many sponsored txs; the real limits are checked right below.
process.env.SPONSOR_PER_WALLET_PER_HOUR ??= "1000";
{
  const { SponsorLimits } = await import("../app/chain.js");
  const lim = new SponsorLimits(2, 3);
  const t = Date.now();
  const r = [
    lim.allow("a", t),
    lim.allow("a", t),
    lim.allow("a", t), // third in the hour for one wallet: no
    lim.allow("b", t),
    lim.allow("c", t), // fourth for the whole app today: no
    lim.allow("a", t + 3_600_001), // next hour, but the day is full: no
  ];
  check(
    JSON.stringify(r) ===
      JSON.stringify([true, true, false, true, false, false]),
    "sponsor limits: per wallet per hour and per day (then the wallet pays)",
    JSON.stringify(r),
  );
}

async function waitFor(
  what: string,
  cond: () => Promise<boolean>,
  minutes = 20,
) {
  const until = Date.now() + minutes * 60_000;
  let said = false;
  while (Date.now() < until) {
    try {
      if (await cond()) return;
    } catch {
      /* keep polling */
    }
    if (!said) console.log(`waiting for ${what}…`);
    said = true;
    await sleep(5000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
await waitFor(
  "the headcount IDL (pledge, check_in_with_pass)",
  async () =>
    existsSync(IDL) &&
    readFileSync(IDL, "utf8").includes("check_in_with_pass") &&
    readFileSync(IDL, "utf8").includes("refund_pledge"),
);
await waitFor(
  "the headcount program on the validator",
  async () => !!(await connection.getAccountInfo(PROGRAM_ID))?.executable,
);

async function airdrop(to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
async function funded() {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, 2);
  return kp;
}
const [organizer, p1, p2, p3, backer, sponsor] = await Promise.all([
  funded(),
  funded(),
  funded(),
  funded(),
  funded(),
  funded(),
]);
// USDC but 0 SOL: only a sponsored app can serve it.
const poor = Keypair.generate();
const mint = await createMint(
  connection,
  organizer,
  organizer.publicKey,
  null,
  6,
);
for (const p of [p1, p2, p3, backer, poor]) {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    organizer,
    mint,
    p.publicKey,
  );
  await mintTo(
    connection,
    organizer,
    mint,
    ata.address,
    organizer,
    p === poor ? 10_000_000 : 200_000_000,
  );
}
const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
const balance = async (owner: PublicKey): Promise<bigint> => {
  try {
    return BigInt(
      (await connection.getTokenAccountBalance(ataOf(owner))).value.amount,
    );
  } catch {
    return 0n;
  }
};

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
// Fresh limit files for every run (faucet limits persist in DATA_DIR).
process.env.DATA_DIR = (await import("node:fs")).mkdtempSync(
  (await import("node:path")).join((await import("node:os")).tmpdir(), "headcount-smoke-"),
);
const { createApp } = await import("../app/app.js");
async function start(opts: {
  mint: PublicKey;
  sponsor?: Keypair;
  faucetAuthority?: Keypair;
}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const made = createApp({
    rpcUrl: RPC,
    cluster: "localnet",
    publicUrl: url,
    mint: opts.mint.toBase58(),
    sponsor: opts.sponsor,
    faucetAuthority: opts.faucetAuthority,
  });
  const server = made.app.listen(port);
  await new Promise((r) => server.once("listening", r));
  return { url, server, chain: made.chain };
}
// A: the app under test, with sponsored fees. C: same token, no sponsor.
// B: configured with another mint, to create an event A must refuse.
const A = await start({ mint, sponsor, faucetAuthority: organizer });
const C = await start({ mint });
const otherMint = await createMint(
  connection,
  organizer,
  organizer.publicKey,
  null,
  6,
);
const B = await start({ mint: otherMint });
const base = A.url;
const chain = A.chain;

{
  const visitor = Keypair.generate();
  const ask = () =>
    fetch(`${base}/api/faucet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: visitor.publicKey.toBase58() }),
    });
  const first = await ask();
  const bal = await connection
    .getTokenAccountBalance(
      getAssociatedTokenAddressSync(mint, visitor.publicKey),
      "confirmed",
    )
    .then((b) => b.value.amount)
    .catch(() => "0");
  check(
    first.ok && bal === "20000000",
    "faucet: a visitor wallet with 0 SOL gets 20 test tokens",
    `status ${first.status}, balance ${bal}`,
  );
  const second = await ask();
  check(
    second.status === 429,
    "faucet: once per wallet per day",
    `status ${second.status}`,
  );
  const off = await fetch(`${C.url}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: visitor.publicKey.toBase58() }),
  });
  check(
    off.status === 404,
    "faucet: off unless a mint authority is configured",
  );
}

async function post(path: string, account: string, at = base) {
  const r = await fetch(at + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}
async function wallet(
  path: string,
  kp: Keypair,
  opts: { relay?: boolean; base?: string } = {},
) {
  const { status, body } = await post(
    path,
    kp.publicKey.toBase58(),
    opts.base ?? base,
  );
  if (status !== 200 || !body.transaction)
    throw new Error(
      `${path} -> ${status} ${body.message ?? JSON.stringify(body)}`,
    );
  const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
  const payer = tx.feePayer!;
  if (!payer.equals(kp.publicKey) && !payer.equals(sponsor.publicKey))
    throw new Error("unexpected fee payer");
  // The wallet adds its signature; a sponsored tx already carries the app's.
  tx.partialSign(kp);
  if (opts.relay) {
    // the browser-wallet path: sign only, the app relays and confirms
    const s = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.serialize().toString("base64") }),
    });
    const j = (await s.json()) as { signature?: string; message?: string };
    if (s.status !== 200 || !j.signature)
      throw new Error(`/api/send -> ${s.status} ${j.message}`);
    return { sig: j.signature, message: body.message, feePayer: payer };
  }
  const sig = await connection.sendRawTransaction(tx.serialize());
  const bh = await connection.getLatestBlockhash("confirmed");
  const res = await connection.confirmTransaction(
    { signature: sig, ...bh },
    "confirmed",
  );
  if (res.value.err)
    throw new Error(`tx failed: ${JSON.stringify(res.value.err)}`);
  return { sig, message: body.message, feePayer: payer };
}
async function walletOk(
  path: string,
  kp: Keypair,
  label: string,
  opts: { relay?: boolean; base?: string } = {},
) {
  try {
    const r = await wallet(path, kp, opts);
    check(true, label);
    return r;
  } catch (e) {
    check(false, label, (e as Error).message.slice(0, 200));
    return null;
  }
}
async function expectRefused(
  path: string,
  kp: Keypair,
  re: RegExp,
  label: string,
  at = base,
) {
  const { status, body } = await post(path, kp.publicKey.toBase58(), at);
  const ok = status >= 400 && status < 500 && re.test(body.message ?? "");
  check(ok, label, `${status}: ${body.message}`);
}
type Ev = {
  status: string;
  action: string;
  go: boolean;
  participants: number;
  checkedIn: number;
  cancelled: boolean;
  price: unknown;
  priceText: string;
  unit: string;
  minAmount: string;
  totalCommitted: string;
  pledged: string;
  backers: number;
  doorKey: string | null;
};
async function eventApi(event: string, at = base) {
  await sleep(1100); // the API caches for 1 s
  const r = await fetch(`${at}/api/event/${event}`);
  return (await r.json()) as Ev;
}
async function page(path: string) {
  const r = await fetch(base + path);
  return { status: r.status, html: await r.text() };
}
const chainNow = async () =>
  (await connection.getBlockTime(await connection.getSlot("confirmed")))!;
async function sleepUntilChain(unix: number) {
  while ((await chainNow()) < unix) await sleep(500);
}

async function createEvent(p: {
  base?: string;
  title: string;
  kind: "ticket" | "deposit";
  price: string;
  min: number;
  budget?: string;
  deadlineIn: number;
  endIn: number;
}) {
  const now = await chain.chainNow();
  const deadline = now + p.deadlineIn;
  const end = now + p.endIn;
  const qs = new URLSearchParams({
    title: p.title,
    kind: p.kind,
    price: p.price,
    min: String(p.min),
    deadline: String(deadline),
    end: String(end),
  });
  if (p.budget) qs.set("budget", p.budget);
  const b = p.base ?? base;
  const r = await fetch(`${b}/api/create-link?${qs}`);
  const link = (await r.json()) as {
    eventId: string;
    txUrl: string;
    solanaUrl: string;
  };
  if (r.status !== 200)
    throw new Error(`create-link ${r.status} ${JSON.stringify(link)}`);
  await wallet(link.txUrl, organizer, { base: b });
  const f = (await (await fetch(`${b}/api/find/${link.eventId}`)).json()) as {
    address: string | null;
  };
  if (!f.address) throw new Error("created event not found via /api/find");
  return {
    event: f.address,
    eventId: link.eventId,
    deadline,
    end,
    solanaUrl: link.solanaUrl,
  };
}

function signPass(door: Keypair, event: string, expiresAt: number) {
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(BigInt(expiresAt));
  const message = Buffer.concat([
    Buffer.from("headcount-pass:v1"),
    new PublicKey(event).toBuffer(),
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
  return bs58.encode(edSign(null, message, key));
}
const passPath = (event: string, exp: number, sig: string) =>
  `/api/tx/pass/${event}?exp=${exp}&sig=${sig}`;

try {
  for (const path of ["/", "/new"]) {
    const { status, html } = await page(path);
    check(
      status === 200 && !html.includes('<div class="err">'),
      `GET ${path} renders without errors`,
      String(status),
    );
  }
  const home = await page("/");
  check(
    home.html.includes("Headcount") && !/Go\/No-Go/.test(home.html),
    "branding: Headcount, no Go/No-Go left",
  );

  // Deadlines ~75 s out: commits, pledges and pre-deadline checks first,
  // then door check-in, payouts and refunds, then the sweep after the end.
  const go = await createEvent({
    title: "Smoke GO",
    kind: "ticket",
    price: "5",
    min: 2,
    deadlineIn: 75,
    endIn: 140,
  });
  check(true, "create_event via /api/tx/create (ticket, min 2)");
  check(
    go.solanaUrl.startsWith("solana:http%3A%2F%2F"),
    "create link is a solana: transaction-request URL",
  );
  const nogo = await createEvent({
    title: "Smoke NO-GO",
    kind: "ticket",
    price: "7",
    min: 4,
    deadlineIn: 75,
    endIn: 140,
  });
  const dep = await createEvent({
    title: "Smoke Deposit",
    kind: "deposit",
    price: "2",
    min: 2,
    deadlineIn: 75,
    endIn: 125,
  });
  const budgetGo = await createEvent({
    title: "Budget GO",
    kind: "ticket",
    price: "5",
    min: 1,
    budget: "20",
    deadlineIn: 75,
    endIn: 140,
  });
  const budgetNo = await createEvent({
    title: "Budget no crowd",
    kind: "ticket",
    price: "5",
    min: 3,
    budget: "30",
    deadlineIn: 75,
    endIn: 140,
  });
  const cancelEv = await createEvent({
    title: "Smoke Cancel",
    kind: "ticket",
    price: "3",
    min: 2,
    deadlineIn: 600,
    endIn: 900,
  });
  const foreign = await createEvent({
    base: B.url,
    title: "Other token",
    kind: "ticket",
    price: "1",
    min: 2,
    deadlineIn: 600,
    endIn: 900,
  });
  check(
    true,
    "six more events created (NO-GO, deposit, two budget, cancel, other token)",
  );
  const badBudget = await fetch(
    `${base}/api/create-link?${new URLSearchParams({ title: "x", kind: "deposit", price: "1", min: "1", budget: "5", deadline: String((await chainNow()) + 60), end: String((await chainNow()) + 120) })}`,
  );
  check(
    badBudget.status === 400 &&
      /only possible for ticket events/.test(
        ((await badBudget.json()) as { message: string }).message,
      ),
    "a budget goal on a deposit event is refused",
  );

  const findAs = async (id: string, org: string) =>
    (await (await fetch(`${base}/api/find/${id}?organizer=${org}`)).json()) as {
      found: boolean;
      address: string | null;
    };
  check(
    (await findAs(go.eventId, organizer.publicKey.toBase58())).address ===
      go.event,
    "/api/find resolves organizer + event id to the event PDA",
  );
  check(
    !(await findAs(go.eventId, p1.publicKey.toBase58())).found,
    "/api/find with another organizer does not match the same event id",
  );

  const meta = (await (
    await fetch(`${base}/api/tx/commit/${go.event}`)
  ).json()) as { label?: string; icon?: string };
  check(
    /^Headcount/.test(meta.label ?? "") &&
      /^http.*\/brand\/headcount-mark-512\.png$/.test(meta.icon ?? ""),
    "GET transaction request returns {label, icon} with the Headcount mark",
    `${meta.label} ${meta.icon}`,
  );
  const iconRes = await fetch(meta.icon!);
  check(
    iconRes.status === 200 &&
      /image\/png/.test(iconRes.headers.get("content-type") ?? ""),
    "brand icon is served statically",
  );

  const bad = await post(`/api/tx/commit/${go.event}`, "not-a-key");
  check(
    bad.status === 400,
    "POST with an invalid account returns 400",
    `${bad.status}: ${bad.body.message}`,
  );
  const noBody = await fetch(`${base}/api/tx/commit/${go.event}`, {
    method: "POST",
  });
  check(
    noBody.status === 400,
    "POST without a body returns 400",
    String(noBody.status),
  );
  const unknown = await post(
    `/api/tx/commit/${Keypair.generate().publicKey.toBase58()}`,
    p1.publicKey.toBase58(),
  );
  check(
    unknown.status === 404,
    "unknown event returns 404",
    String(unknown.status),
  );
  await expectRefused(
    `/api/tx/commit/${go.event}`,
    Keypair.generate(),
    /USDC/,
    "wallet without USDC gets a clear error",
  );

  const fr = await post(
    `/api/tx/commit/${foreign.event}`,
    p1.publicKey.toBase58(),
  );
  check(
    fr.status === 400 &&
      /different token than this app/.test(fr.body.message ?? ""),
    "tx endpoints refuse an event in a different token (400)",
    `${fr.status}: ${fr.body.message}`,
  );
  const fj = await eventApi(foreign.event);
  check(
    (await page(`/e/${foreign.event}`)).html.includes(
      "different token than this app",
    ) && fj.unit !== "USDC",
    "other-token event page warns and does not call it USDC",
    fj.unit,
  );

  const c1 = await walletOk(
    `/api/tx/commit/${go.event}`,
    p1,
    "p1 commits 5 USDC",
  );
  check(
    !!c1 && c1.feePayer.equals(sponsor.publicKey),
    "sponsored app: the app is the fee payer",
  );
  let s = await eventApi(go.event);
  check(
    s.participants === 1 && s.status === "OPEN",
    "1 / 2 committed, OPEN",
    `${s.participants} ${s.status}`,
  );
  check(
    s.price === "5000000" && s.priceText === "5",
    "API returns u64 amounts as integer strings",
    `${JSON.stringify(s.price)} ${s.priceText}`,
  );
  await expectRefused(
    `/api/tx/commit/${go.event}`,
    p1,
    /already committed/,
    "committing twice returns a clear error",
  );
  await walletOk(
    `/api/tx/commit/${go.event}`,
    p2,
    "p2 commits 5 USDC via the /api/send relay",
    { relay: true },
  );
  s = await eventApi(go.event);
  check(
    s.participants === 2 && s.status === "GO",
    "/api/event shows GO at 2 / 2",
    `${s.participants} ${s.status}`,
  );
  check(
    (await page(`/e/${go.event}`)).html.includes("No SOL needed"),
    "event page says No SOL needed when sponsored",
  );
  await expectRefused(
    `/api/tx/withdraw/${go.event}`,
    organizer,
    /after the commit deadline/,
    "withdraw before the deadline is refused",
  );
  await expectRefused(
    `/api/tx/withdraw/${go.event}`,
    p1,
    /organizer/,
    "only the organizer can withdraw",
  );
  await expectRefused(
    `/api/tx/refund/${go.event}`,
    p1,
    /deadline/,
    "no refund before the deadline",
  );
  const adminPath = `/e/${go.event}/admin?organizer=${organizer.publicKey.toBase58()}`;
  check(
    (await page(adminPath)).html.includes('id="cancel"'),
    "organizer page offers cancel before the deadline",
  );

  await expectRefused(
    `/api/tx/commit/${nogo.event}`,
    poor,
    /no SOL/,
    "without a sponsor, a 0-SOL wallet gets a clear error",
    C.url,
  );

  await walletOk(
    `/api/tx/commit/${nogo.event}`,
    poor,
    "sponsored commit from a wallet with 0 SOL",
  );
  const poorC = await chain.getCommitment(
    new PublicKey(nogo.event),
    poor.publicKey,
  );
  check(
    (await connection.getBalance(poor.publicKey)) === 0 &&
      !!poorC &&
      poorC.rentPayer.equals(sponsor.publicKey),
    "the wallet still has 0 SOL; the app paid fees and rent",
  );

  const p1Before = await balance(p1.publicKey);
  await walletOk(
    `/api/tx/commit/${nogo.event}`,
    p1,
    "p1 commits 7 USDC to the NO-GO event",
  );
  const p3c = await walletOk(
    `/api/tx/commit/${nogo.event}`,
    p3,
    "p3 commits via the unsponsored app (pays own fees)",
    { base: C.url },
  );
  check(
    !!p3c && p3c.feePayer.equals(p3.publicKey),
    "unsponsored app: the wallet is the fee payer",
  );

  await walletOk(
    `/api/tx/commit/${budgetGo.event}`,
    p1,
    "p1 buys a ticket for the budget event",
  );
  s = await eventApi(budgetGo.event);
  check(
    s.participants === 1 &&
      s.status === "OPEN" &&
      s.totalCommitted === "5000000",
    "headcount met, budget 5 / 20: still OPEN",
    `${s.status} ${s.totalCommitted}`,
  );
  const pl = (await (
    await fetch(`${base}/api/pledge-link/${budgetGo.event}?amount=15`)
  ).json()) as { txUrl: string; solanaUrl: string };
  check(
    /\/api\/tx\/pledge\/.+\?amount=15/.test(pl.txUrl) &&
      pl.solanaUrl.startsWith("solana:"),
    "pledge link carries the amount",
  );
  await walletOk(pl.txUrl, backer, "backer pledges 15 USDC (no seat)");
  s = await eventApi(budgetGo.event);
  check(
    s.status === "GO" &&
      s.participants === 1 &&
      s.backers === 1 &&
      s.pledged === "15000000" &&
      s.totalCommitted === "20000000",
    "budget reached with the pledge: GO, headcount unchanged",
    `${s.status} ${s.participants} ${s.backers} ${s.pledged}`,
  );
  await expectRefused(
    `/api/tx/pledge/${budgetGo.event}?amount=1`,
    backer,
    /already backed/,
    "one pledge per wallet",
  );
  await expectRefused(
    `/api/tx/pledge/${dep.event}?amount=1`,
    backer,
    /Only ticket events/,
    "no pledges on deposit events",
  );
  await expectRefused(
    `/api/tx/pledge/${budgetGo.event}?amount=0`,
    p2,
    /positive/,
    "pledge amount must be positive",
  );
  const bp = await page(`/e/${budgetGo.event}`);
  check(
    bp.html.includes("Back this event") &&
      bp.html.includes('id="money-bar"') &&
      bp.html.includes("can't fake the headcount"),
    "event page shows the budget bar and the backer flow",
  );

  await walletOk(
    `/api/tx/commit/${budgetNo.event}`,
    p1,
    "p1 buys a ticket for the event that lacks people",
  );
  await walletOk(
    `/api/tx/pledge/${budgetNo.event}?amount=100`,
    backer,
    "backer pledges 100 USDC, far above the budget",
  );
  s = await eventApi(budgetNo.event);
  check(
    s.status === "OPEN" && !s.go && s.totalCommitted === "105000000",
    "money covered, 1 / 3 people: backers can't fake the headcount",
    `${s.status} ${s.totalCommitted}`,
  );

  await walletOk(
    `/api/tx/commit/${dep.event}`,
    p1,
    "p1 locks a 2 USDC deposit",
  );
  await walletOk(
    `/api/tx/commit/${dep.event}`,
    p2,
    "p2 locks a 2 USDC deposit",
  );
  await walletOk(
    `/api/tx/commit/${dep.event}`,
    p3,
    "p3 locks a 2 USDC deposit",
  );
  const door = Keypair.generate();
  const earlyExp = (await chainNow()) + 60;
  await expectRefused(
    passPath(dep.event, earlyExp, signPass(door, dep.event, earlyExp)),
    p1,
    /no door screen/,
    "no door screen registered yet: clear error",
  );
  await expectRefused(
    `/api/tx/door/${dep.event}?key=${door.publicKey.toBase58()}`,
    p1,
    /organizer/,
    "only the organizer can register a door screen",
  );
  await walletOk(
    `/api/tx/door/${dep.event}?key=${door.publicKey.toBase58()}`,
    organizer,
    "organizer registers the door screen (set_door_key)",
  );
  s = await eventApi(dep.event);
  check(s.doorKey === door.publicKey.toBase58(), "event carries the door key");
  const early2 = (await chainNow()) + 60;
  await expectRefused(
    passPath(dep.event, early2, signPass(door, dep.event, early2)),
    p1,
    /Check-in opens at the commit deadline/,
    "door pass before the deadline is refused",
  );
  const doorPage = await page(`/e/${dep.event}/door`);
  check(
    doorPage.status === 200 &&
      doorPage.html.includes("door-pass") &&
      doorPage.html.includes("tweetnacl"),
    "door screen page renders",
  );
  await expectRefused(
    `/api/tx/sweep/${dep.event}`,
    organizer,
    /after the event ends/,
    "no sweep before the event ends",
  );

  const p3Before = await balance(p3.publicKey);
  await walletOk(
    `/api/tx/commit/${cancelEv.event}`,
    p3,
    "p3 commits 3 USDC to the cancel event",
  );
  await walletOk(
    `/api/tx/pledge/${cancelEv.event}?amount=4`,
    backer,
    "backer pledges 4 USDC to the cancel event",
  );
  await expectRefused(
    `/api/tx/cancel/${cancelEv.event}`,
    p3,
    /organizer/,
    "only the organizer can cancel",
  );
  await walletOk(
    `/api/tx/cancel/${cancelEv.event}`,
    organizer,
    "organizer cancels the event before the deadline",
  );
  s = await eventApi(cancelEv.event);
  check(
    s.status === "CANCELLED" && s.action === "refund",
    "/api/event shows CANCELLED with refunds open",
    `${s.status} ${s.action}`,
  );
  await expectRefused(
    `/api/tx/commit/${cancelEv.event}`,
    p2,
    /cancelled/,
    "commit after cancel is refused",
  );
  await walletOk(
    `/api/tx/refund/${cancelEv.event}`,
    p3,
    "p3 refunds from the cancelled event right away",
  );
  check((await balance(p3.publicKey)) === p3Before, "p3 got the 3 USDC back");
  const backerBefore = await balance(backer.publicKey);
  await walletOk(
    `/api/tx/refund-pledge/${cancelEv.event}`,
    backer,
    "backer takes the pledge back (refund_pledge)",
  );
  check(
    (await balance(backer.publicKey)) - backerBefore === 4_000_000n,
    "backer got the 4 USDC back",
  );

  for (const path of [
    "/",
    `/e/${go.event}`,
    adminPath,
    `/e/${dep.event}`,
    `/e/${dep.event}/admin`,
    `/e/${cancelEv.event}`,
    `/e/${budgetGo.event}/admin`,
  ]) {
    const { status } = await page(path);
    check(
      status === 200,
      `GET ${path.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, ":key")} renders`,
      String(status),
    );
  }
  const ev = await page(`/e/${nogo.event}`);
  check(
    ev.html.includes("solana:") && ev.html.includes("<svg"),
    "event page contains the solana: QR code",
  );
  check(
    (await page("/e/nope")).status === 400,
    "bad event address page returns 400",
  );
  check(
    /can no longer be cancelled/.test(
      chain.explain({ InstructionError: [0, { Custom: 6019 }] }, [
        "Program log: AnchorError occurred. Error Code: CancelTooLate.",
      ]),
    ),
    "preflight error mapping knows CancelTooLate",
  );

  await sleepUntilChain(
    Math.max(
      go.deadline,
      nogo.deadline,
      dep.deadline,
      budgetGo.deadline,
      budgetNo.deadline,
    ) + 1,
  );

  // door check-in first: it has to happen before the event end
  const now1 = await chainNow();
  const wrongKey = Keypair.generate();
  await expectRefused(
    passPath(dep.event, now1 + 60, signPass(wrongKey, dep.event, now1 + 60)),
    p1,
    /not valid/,
    "a pass signed by another key is refused",
  );
  await expectRefused(
    passPath(dep.event, now1 + 60, signPass(door, cancelEv.event, now1 + 60)),
    p1,
    /not valid/,
    "a pass for another event is refused",
  );
  await expectRefused(
    passPath(dep.event, now1 - 5, signPass(door, dep.event, now1 - 5)),
    p1,
    /expired/,
    "an expired pass is refused",
  );
  await expectRefused(
    passPath(dep.event, now1 + 600, signPass(door, dep.event, now1 + 600)),
    p1,
    /not valid/,
    "a pass valid for more than two minutes is refused",
  );
  const passLinkBad = await fetch(
    `${base}/api/pass-link/${dep.event}?exp=${now1 + 60}&sig=${signPass(wrongKey, dep.event, now1 + 60)}`,
  );
  check(
    passLinkBad.status === 409,
    "pass-link refuses a screen that is not the registered door",
    String(passLinkBad.status),
  );
  const exp = (await chainNow()) + 90;
  const sig = signPass(door, dep.event, exp);
  const passLink = (await (
    await fetch(`${base}/api/pass-link/${dep.event}?exp=${exp}&sig=${sig}`)
  ).json()) as { solanaUrl?: string };
  check(
    !!passLink.solanaUrl && passLink.solanaUrl.startsWith("solana:"),
    "door screen gets a solana: pass link",
  );
  const p1Dep = await balance(p1.publicKey);
  const pass1 = await walletOk(
    passPath(dep.event, exp, sig),
    p1,
    "p1 scans the door pass and checks herself in",
  );
  check(
    !!pass1 && pass1.feePayer.equals(sponsor.publicKey),
    "door check-in fees are sponsored",
  );
  check(
    (await balance(p1.publicKey)) - p1Dep === 2_000_000n,
    "door check-in returned p1's 2 USDC deposit",
  );
  await expectRefused(
    passPath(dep.event, exp, sig),
    p1,
    /Already checked in/,
    "the same person cannot check in twice",
  );
  await expectRefused(
    `/api/tx/checkin/${dep.event}/${p3.publicKey.toBase58()}`,
    p2,
    /organizer/,
    "a non-organizer cannot do the manual check-in",
  );
  await walletOk(
    `/api/tx/checkin/${dep.event}/${p3.publicKey.toBase58()}`,
    organizer,
    "organizer checks p3 in by hand (fallback)",
  );
  s = await eventApi(dep.event);
  check(
    s.checkedIn === 2,
    "door screen counter: 2 checked in",
    String(s.checkedIn),
  );

  const orgBefore = await balance(organizer.publicKey);
  await walletOk(
    `/api/tx/withdraw/${go.event}`,
    organizer,
    "organizer withdraws after the deadline",
  );
  check(
    (await balance(organizer.publicKey)) - orgBefore === 9_800_000n,
    "organizer received 10 USDC minus the 2 % fee",
  );
  const orgBefore2 = await balance(organizer.publicKey);
  await walletOk(
    `/api/tx/withdraw/${budgetGo.event}`,
    organizer,
    "organizer withdraws the budget event",
  );
  check(
    (await balance(organizer.publicKey)) - orgBefore2 === 19_600_000n,
    "organizer received tickets + pledge (20 USDC minus the 2 % fee)",
  );
  await expectRefused(
    `/api/tx/refund/${go.event}`,
    p1,
    /GO/,
    "no refund from a GO event",
  );
  await expectRefused(
    `/api/tx/commit/${go.event}`,
    p3,
    /deadline has passed/,
    "commit after the deadline is refused",
  );
  await sleep(1100);
  check(
    !(await page(adminPath)).html.includes('id="cancel"'),
    "organizer page hides cancel after the deadline",
  );

  s = await eventApi(nogo.event);
  check(
    s.status === "NO-GO" && s.action === "refund",
    "/api/event shows NO-GO after the deadline",
    `${s.status} ${s.action}`,
  );
  await expectRefused(
    `/api/tx/cancel/${nogo.event}`,
    organizer,
    /deadline has passed; the event can no longer be cancelled/,
    "cancel after the deadline is refused",
  );
  await walletOk(
    `/api/tx/refund/${nogo.event}`,
    p1,
    "p1 refunds herself from the NO-GO event",
  );
  // p1's deposit came back at check-in, so only the 7 USDC were outstanding
  check(
    (await balance(p1.publicKey)) - p1Before === 0n - 5_000_000n - 5_000_000n,
    "refund returned the 7 USDC (p1's two budget tickets stay spent)",
  );
  await expectRefused(
    `/api/tx/refund/${nogo.event}`,
    p1,
    /No commitment/,
    "refunding twice is refused",
  );
  const p3Sol = await connection.getBalance(p3.publicKey);
  await walletOk(
    `/api/tx/refund/${nogo.event}`,
    p3,
    "p3 refunds (rent goes back to p3, who paid it)",
  );
  check(
    (await connection.getBalance(p3.publicKey)) > p3Sol,
    "p3's SOL went up: rent returned to its payer",
  );
  const sponsorMid = await connection.getBalance(sponsor.publicKey);
  await walletOk(
    `/api/tx/refund/${nogo.event}`,
    poor,
    "0-SOL wallet refunds (sponsored)",
  );
  check(
    (await balance(poor.publicKey)) === 10_000_000n &&
      (await connection.getBalance(poor.publicKey)) === 0,
    "USDC back to the 0-SOL wallet, still 0 SOL",
  );
  check(
    (await connection.getBalance(sponsor.publicKey)) > sponsorMid,
    "the commitment rent went back to the app that paid it",
  );

  s = await eventApi(budgetNo.event);
  check(
    s.status === "NO-GO",
    "budget covered but too few people: NO-GO",
    s.status,
  );
  const backerBefore2 = await balance(backer.publicKey);
  await walletOk(
    `/api/tx/refund/${budgetNo.event}`,
    backer,
    "backer refunds the pledge from the NO-GO event",
  );
  check(
    (await balance(backer.publicKey)) - backerBefore2 === 100_000_000n,
    "backer got the 100 USDC back",
  );
  await walletOk(
    `/api/tx/refund/${budgetNo.event}`,
    p1,
    "p1 refunds the ticket from the NO-GO budget event",
  );
  await expectRefused(
    `/api/tx/refund-pledge/${budgetNo.event}`,
    backer,
    /No pledge/,
    "refunding a pledge twice is refused",
  );

  await sleepUntilChain(dep.end + 1);
  const orgBefore3 = await balance(organizer.publicKey);
  await walletOk(
    `/api/tx/sweep/${dep.event}`,
    organizer,
    "organizer sweeps after the event",
  );
  check(
    (await balance(organizer.publicKey)) - orgBefore3 === 1_900_000n,
    "the no-show's 2 USDC went to the organizer (pizza), minus the 5 % fee",
  );
  s = await eventApi(dep.event);
  check(
    s.status === "DONE" && s.checkedIn === 2,
    "/api/event shows DONE, 2 checked in",
    `${s.status} ${s.checkedIn}`,
  );

  await sleepUntilChain(Math.max(go.end, budgetGo.end) + 1);
  const sponsorBeforeReclaim = await connection.getBalance(sponsor.publicKey);
  const reclaimed = await chain.reclaimSponsoredRent();
  const { settledAt } = await import("../app/chain.js");
  const now2 = await chain.chainNow();
  let leftSettled = 0;
  for (const name of ["commitment", "pledge"] as const) {
    const accs = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { memcmp: (chain as any).program.coder.accounts.memcmp(name) },
        {
          memcmp: {
            offset: name === "commitment" ? 81 : 80,
            bytes: sponsor.publicKey.toBase58(),
          },
        },
      ],
    });
    for (const { account } of accs) {
      const a = (chain as any).program.coder.accounts.decode(
        name,
        account.data,
      );
      const ev = await chain.getEvent(a.event);
      if (ev && settledAt(ev, now2)) leftSettled++;
    }
  }
  check(
    reclaimed > 0 &&
      leftSettled === 0 &&
      (await connection.getBalance(sponsor.publicKey)) > sponsorBeforeReclaim,
    "app reclaims the rent it sponsored once events are settled",
    `${reclaimed} closed, ${leftSettled} settled left`,
  );

  const { refundable } = await import("../app/chain.js");
  const openRefunds = async () => {
    const t = await chain.chainNow();
    let n = 0;
    for (const e of await chain.allEvents(mint.toBase58())) {
      if (!refundable(e, t)) continue;
      const k = new PublicKey(e.address);
      n += (await chain.commitments(k)).length;
      if (e.kind === "ticket") n += (await chain.pledges(k)).length;
    }
    return n;
  };
  const crankEvent = await createEvent({
    title: "Smoke crank",
    kind: "ticket",
    price: "3",
    min: 3,
    deadlineIn: 25,
    endIn: 60,
  });
  await walletOk(
    `/api/tx/commit/${crankEvent.event}`,
    p3,
    "p3 commits to an event that will miss its minimum",
  );
  await sleepUntilChain(crankEvent.deadline + 1);
  const openBefore = await openRefunds();
  const cranked = await chain.crankRefunds(0, 20);
  check(
    openBefore > 0 && cranked === openBefore && (await openRefunds()) === 0,
    "the refund crank pays back everyone still waiting on NO-GO events, at the app's cost",
    `${openBefore} open, ${cranked} refunded`,
  );

  const web3js = await fetch(`${base}/vendor/web3.iife.min.js`);
  const nacl = await fetch(`${base}/vendor/nacl-fast.min.js`);
  const other = await fetch(`${base}/vendor/..%2Fpackage.json`);
  check(
    web3js.ok && nacl.ok && other.status === 404,
    "browser libraries come from the app itself, nothing else under /vendor",
  );
  const landing = await fetch(`${base}/`);
  check(
    /default-src 'self'/.test(
      landing.headers.get("content-security-policy") ?? "",
    ) && !(await landing.text()).includes("cdn.jsdelivr.net"),
    "pages send a content security policy and load no CDN scripts",
  );
} catch (e) {
  console.error(e);
  failures++;
} finally {
  for (const x of [A, B, C]) x.server.close();
  console.log(
    failures ? `\n${failures} check(s) failed` : "\nall app checks passed",
  );
  process.exit(failures ? 1 : 0);
}
