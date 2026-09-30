import anchor from "@coral-xyz/anchor";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import QRCode from "qrcode";
import { createRequire } from "node:module";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  Chain,
  formatUnits,
  isGo,
  parsePubkey,
  SponsorLimits,
  parseUnits,
  passMessage,
  PROGRAM_ID,
  statusOf,
  actionOf,
  cancellable,
  checkInOpen,
  MAX_PASS_SECS,
  U64_MAX,
  UserError,
  verifyEd25519,
  type Built,
  type CommitmentView,
  type EventView,
  type Kind,
  type PledgeView,
} from "./chain.js";
import * as views from "./views.js";

const bs58 = anchor.utils.bytes.bs58;
const require = createRequire(import.meta.url);
const BRAND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../brand");
const PITCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../pitch");

export interface AppConfig {
  rpcUrl: string;
  cluster: "localnet" | "devnet";
  publicUrl: string;
  mint?: string;
  /** Display symbol of MINT (default "USDC"); other mints are never called that. */
  symbol?: string;
  sponsor?: Keypair;
  /** Test networks only: mint authority of MINT, for the demo token faucet. */
  faucetAuthority?: Keypair;
}

export function createApp(config: AppConfig) {
  const chain = new Chain(config.rpcUrl, {
    appMint: config.mint,
    symbol: config.symbol,
    sponsor: config.sponsor,
  });
  const sym = chain.symbol;
  const base = config.publicUrl.replace(/\/+$/, "");
  const app = express();
  app.disable("x-powered-by");
  // Behind Traefik: makes req.ip the client address for the faucet's per-IP limit.
  if (process.env.TRUST_PROXY)
    app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
  app.use(express.json({ limit: "64kb" }));

  const hasBrand = existsSync(resolve(BRAND_DIR, "headcount-logo.svg"));
  const ctx: views.ViewContext = {
    cluster: config.cluster,
    rpcUrl: config.rpcUrl,
    programId: PROGRAM_ID.toBase58(),
    symbol: chain.symbol,
    sponsored: !!config.sponsor,
    brand: hasBrand,
    faucet: !!(config.faucetAuthority && config.mint),
  };
  // Solana Pay needs an absolute icon URL.
  const payIcon = existsSync(resolve(BRAND_DIR, "headcount-mark-512.png"))
    ? `${base}/brand/headcount-mark-512.png`
    : `${base}/icon.svg`;

  const solanaPayUrl = (path: string) =>
    `solana:${encodeURIComponent(base + path)}`;
  const qrSvg = (data: string) =>
    QRCode.toString(data, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#111110", light: "#ffffff" },
    });
  const link = async (path: string) => {
    const solanaUrl = solanaPayUrl(path);
    return { txPath: path, solanaUrl, qr: await qrSvg(solanaUrl) };
  };

  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  // Public RPCs answer 429 now and then: serve the last good read instead of an error.
  const lastGood = new Map<string, { at: number; value: unknown }>();
  const STALE_MS = 10 * 60_000;
  function cached<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = fn().then(
      (v) => {
        lastGood.set(key, { at: Date.now(), value: v });
        return v;
      },
      (e: unknown) => {
        cache.delete(key);
        const old = lastGood.get(key);
        if (old && Date.now() - old.at < STALE_MS) return old.value as T;
        throw e;
      },
    );
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function eventJson(key: PublicKey) {
    return cached(`event:${key.toBase58()}`, 1000, async () => {
      const e = await chain.getEvent(key);
      if (!e) return null;
      const [now, commitments, pledges, vault, token] = await Promise.all([
        chain.chainNow(),
        chain.commitments(key),
        e.kind === "ticket" ? chain.pledges(key) : Promise.resolve([]),
        chain.vaultBalance(e),
        chain.tokenInfo(new PublicKey(e.mint)),
      ]);
      return enrich(e, now, token.decimals, { commitments, pledges, vault });
    });
  }

  function enrich(
    e: EventView,
    now: number,
    decimals: number,
    extra: {
      commitments?: CommitmentView[];
      pledges?: PledgeView[];
      vault?: bigint;
    } = {},
  ): views.EventData {
    const status = statusOf(e, now);
    const action = actionOf(e, now);
    const unit = chain.isAppToken(e) ? sym : short(e.mint);
    const fmt = (v: bigint | string) => formatUnits(v, decimals);
    const budget = BigInt(e.minAmount);
    const committed = BigInt(e.totalCommitted);
    const moneyNeed = budget > committed ? budget - committed : 0n;
    const { commitments, pledges, vault } = extra;
    return {
      ...e,
      status,
      action,
      go: isGo(e),
      appToken: chain.isAppToken(e),
      unit,
      canCancel: cancellable(e, now),
      checkInOpen: checkInOpen(e, now),
      hasBudget: budget > 0n,
      verdict: views.verdict({
        ...e,
        status,
        action,
        unit,
        budgetText: fmt(budget),
        moneyNeedText: moneyNeed > 0n ? fmt(moneyNeed) : "",
      }),
      now,
      decimals,
      priceText: fmt(e.price),
      withdrawnText: fmt(e.withdrawn),
      minAmountText: fmt(e.minAmount),
      totalCommittedText: fmt(e.totalCommitted),
      pledgedText: fmt(e.pledged),
      vault: vault?.toString(),
      vaultText: vault === undefined ? undefined : fmt(vault),
      commitments: commitments?.map((c) => ({
        ...c,
        amountText: fmt(c.amount),
      })),
      pledges: pledges?.map((p) => ({ ...p, amountText: fmt(p.amount) })),
    };
  }
  type EventJson = views.EventData;

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  const cors = (_req: Request, res: Response, next: NextFunction) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Accept-Encoding",
    });
    next();
  };
  app.use("/api", cors);
  app.options("/api/{*rest}", (_req, res) => {
    res.sendStatus(204);
  });

  const txRoute = (
    path: string,
    label: (req: Request) => Promise<string> | string,
    build: (
      req: Request,
      account: PublicKey,
    ) => Promise<Built & { message: string }>,
  ) => {
    app.get(
      path,
      wrap(async (req, res) => {
        res.json({ label: await label(req), icon: payIcon });
      }),
    );
    app.post(
      path,
      wrap(async (req, res) => {
        const account = parsePubkey(req.body?.account, "account");
        const built = await build(req, account);
        const transaction = await chain.finalize(built);
        res.json({ transaction, message: built.message });
      }),
    );
  };

  const eventParam = (req: Request) =>
    parsePubkey(req.params.event, "event address");
  const paid = (feePayer: PublicKey, account: PublicKey) =>
    feePayer.equals(account) ? "" : " Network fees are covered by Headcount.";

  txRoute(
    "/api/tx/commit/:event",
    () => "Headcount · commit",
    async (req, account) => {
      const event = eventParam(req);
      const b = await chain.buildCommit(event, account);
      const message =
        b.e.kind === "ticket"
          ? `Commit ${b.amount} ${sym} to "${b.e.title}". If it does not reach its minimum by the deadline, you get it back.`
          : `Lock a ${b.amount} ${sym} deposit for "${b.e.title}". You get it back when you check in at the door. Your ticket: ${base}/e/${event.toBase58()}/ticket/${account.toBase58()}`;
      return { ...b, message: message + paid(b.feePayer, account) };
    },
  );

  const pledgeAmount = async (req: Request, event: PublicKey) => {
    const e = await chain.mustGetEvent(event);
    const { decimals } = await chain.tokenInfo(new PublicKey(e.mint));
    const raw = typeof req.query.amount === "string" ? req.query.amount : "";
    const amount = parseUnits(raw, decimals);
    if (amount === null || amount <= 0n || amount > U64_MAX)
      throw new UserError(
        `Pledge a positive ${sym} amount (max ${decimals} decimals).`,
      );
    return amount;
  };

  txRoute(
    "/api/tx/pledge/:event",
    (req) =>
      `Headcount · back this event${typeof req.query.amount === "string" ? ` (${req.query.amount.slice(0, 20)} ${sym})` : ""}`,
    async (req, account) => {
      const event = eventParam(req);
      const b = await chain.buildPledge(
        event,
        account,
        await pledgeAmount(req, event),
      );
      return {
        ...b,
        message:
          `Back "${b.e.title}" with ${b.amount} ${sym}. You get no seat; it counts toward the budget, not the headcount. If the event does not happen, you get it back.` +
          paid(b.feePayer, account),
      };
    },
  );

  for (const [path, only] of [
    ["/api/tx/refund/:event", undefined],
    ["/api/tx/refund-pledge/:event", "pledge"],
  ] as const) {
    txRoute(
      path,
      () => "Headcount · refund",
      async (req, account) => {
        const b = await chain.buildRefund(eventParam(req), account, only);
        return {
          ...b,
          message:
            `Take back your ${b.amount} ${sym} (${b.what}) from "${b.e.title}".` +
            paid(b.feePayer, account),
        };
      },
    );
  }

  txRoute(
    "/api/tx/checkin/:event/:participant",
    () => "Headcount · check-in",
    async (req, account) => {
      const participant = parsePubkey(req.params.participant, "participant");
      const b = await chain.buildCheckIn(eventParam(req), participant, account);
      return {
        ...b,
        message: `Check in ${short(participant.toBase58())} at "${b.e.title}" and return their ${b.amount} ${sym} deposit.`,
      };
    },
  );

  const passParams = (req: Request) => {
    const exp = typeof req.query.exp === "string" ? req.query.exp : "";
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!/^\d{1,12}$/.test(exp))
      throw new UserError("This door pass is not valid for this event.");
    let signature: Uint8Array;
    try {
      signature = bs58.decode(sig);
    } catch {
      throw new UserError("This door pass is not valid for this event.");
    }
    if (signature.length !== 64)
      throw new UserError("This door pass is not valid for this event.");
    return { expiresAt: Number(exp), signature };
  };

  txRoute(
    "/api/tx/pass/:event",
    () => "Headcount · check in at the door",
    async (req, account) => {
      const { expiresAt, signature } = passParams(req);
      const b = await chain.buildPassCheckIn(
        eventParam(req),
        account,
        expiresAt,
        signature,
      );
      return {
        ...b,
        message:
          `Check in at "${b.e.title}": your ${b.amount} ${sym} deposit comes straight back.` +
          paid(b.feePayer, account),
      };
    },
  );

  txRoute(
    "/api/tx/door/:event",
    () => "Headcount · register door screen",
    async (req, account) => {
      const key = parsePubkey(req.query.key, "door key");
      const b = await chain.buildSetDoorKey(eventParam(req), account, key);
      return {
        ...b,
        message: `Register this door screen (${short(key.toBase58())}) for "${b.e.title}". Its passes let attendees check themselves in.`,
      };
    },
  );

  for (const method of ["withdraw", "sweep"] as const) {
    txRoute(
      `/api/tx/${method}/:event`,
      () => `Headcount · ${method}`,
      async (req, account) => {
        const b = await chain.buildPayout(method, eventParam(req), account);
        return {
          ...b,
          message:
            method === "withdraw"
              ? `Withdraw ${b.net} ${sym} (tickets and pledges, after the 2 % fee) from "${b.e.title}".`
              : `Sweep ${b.net} ${sym} of no-show deposits (after the 5 % fee) from "${b.e.title}". Pizza is on them.`,
        };
      },
    );
  }

  txRoute(
    "/api/tx/cancel/:event",
    () => "Headcount · cancel event",
    async (req, account) => {
      const b = await chain.buildCancel(eventParam(req), account);
      return {
        ...b,
        message: `Cancel "${b.e.title}". Every participant and backer can then refund themselves.`,
      };
    },
  );

  txRoute(
    "/api/tx/close/:event",
    () => "Headcount · close event",
    async (req, account) => {
      const b = await chain.buildCloseEvent(eventParam(req), account);
      return {
        ...b,
        message: `Close "${b.e.title}". Everyone has their money back; the account rent returns to you.`,
      };
    },
  );

  // event id -> organizers who requested its create tx (ids are unique per organizer).
  // On disk so a restart between "scan QR" and "signed" does not strand the page.
  const creatorsFile = resolve(process.env.DATA_DIR ?? "data", "creators.json");
  const creators = new Map<string, Set<string>>();
  try {
    for (const [k, v] of Object.entries(
      JSON.parse(readFileSync(creatorsFile, "utf8")) as Record<
        string,
        string[]
      >,
    ))
      creators.set(k, new Set(v));
  } catch {
    /* first start */
  }
  function rememberCreator(eventId: bigint, organizer: PublicKey) {
    const key = eventId.toString();
    if (!creators.has(key) && creators.size >= 5000)
      creators.delete(creators.keys().next().value!);
    const set = creators.get(key) ?? new Set<string>();
    if (set.size < 20) set.add(organizer.toBase58());
    creators.set(key, set);
    try {
      mkdirSync(dirname(creatorsFile), { recursive: true });
      const tmp = `${creatorsFile}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(
          Object.fromEntries([...creators].map(([k, v]) => [k, [...v]])),
        ),
      );
      renameSync(tmp, creatorsFile);
    } catch {
      /* lookup still works until the next restart */
    }
  }

  async function parseCreate(q: Record<string, unknown>) {
    if (!config.mint)
      throw new UserError("The server has no MINT configured.", 500);
    const mint = parsePubkey(config.mint, "MINT");
    const { decimals } = await chain.tokenInfo(mint);
    const str = (k: string) =>
      typeof q[k] === "string" ? (q[k] as string) : "";
    const title = str("title").trim();
    if (!title) throw new UserError("Give the event a title.");
    if (Buffer.byteLength(title) > 64)
      throw new UserError("The title can be at most 64 bytes.");
    const kind = str("kind") as Kind;
    if (kind !== "ticket" && kind !== "deposit")
      throw new UserError('kind must be "ticket" or "deposit".');
    const price = parseUnits(str("price"), decimals);
    if (price === null || price <= 0n || price > U64_MAX)
      throw new UserError(
        `Price must be a positive ${sym} amount (max ${decimals} decimals).`,
      );
    const budgetRaw = str("budget").trim();
    const minAmount = budgetRaw === "" ? 0n : parseUnits(budgetRaw, decimals);
    if (minAmount === null || minAmount > U64_MAX)
      throw new UserError(
        `The budget goal must be a ${sym} amount (max ${decimals} decimals), or empty.`,
      );
    if (minAmount > 0n && kind !== "ticket")
      throw new UserError("A budget goal is only possible for ticket events.");
    const int = (k: string, fallback?: number) => {
      const v = str(k);
      if (v === "" && fallback !== undefined) return fallback;
      if (!/^\d+$/.test(v)) throw new UserError(`${k} must be a whole number.`);
      return Number(v);
    };
    const min = int("min");
    const max = int("max", 0);
    if (max > 1_000_000)
      throw new UserError("The maximum can be at most 1,000,000.");
    if (min < 1 || min > 1_000_000)
      throw new UserError("The minimum must be at least 1.");
    if (max !== 0 && max < min)
      throw new UserError("The maximum must not be below the minimum.");
    const deadline = int("deadline");
    const end = int("end");
    if (end < deadline)
      throw new UserError(
        "The event end must not be before the commit deadline.",
      );
    const idStr = str("id");
    if (idStr && !/^\d{1,20}$/.test(idStr))
      throw new UserError("Invalid event id.");
    const eventId = idStr ? BigInt(idStr) : randomU64();
    if (eventId > U64_MAX) throw new UserError("Invalid event id.");
    return {
      title,
      kind,
      price,
      min,
      max,
      minAmount,
      deadline,
      end,
      eventId,
      mint,
      decimals,
    };
  }

  txRoute(
    "/api/tx/create",
    (req) => {
      const t =
        typeof req.query.title === "string" ? req.query.title.slice(0, 64) : "";
      return t ? `Headcount · create "${t}"` : "Headcount · create event";
    },
    async (req, account) => {
      const p = await parseCreate(req.query as Record<string, unknown>);
      const b = await chain.buildCreate(account, p);
      rememberCreator(p.eventId, account);
      return {
        ...b,
        message: `Create "${p.title}" (min ${p.min}, ${formatUnits(p.price, p.decimals)} ${sym}${p.minAmount > 0n ? `, budget ${formatUnits(p.minAmount, p.decimals)} ${sym}` : ""}). Event page: ${base}/e/${b.event.toBase58()}`,
      };
    },
  );

  app.get(
    "/api/create-link",
    wrap(async (req, res) => {
      const p = await parseCreate(req.query as Record<string, unknown>);
      const now = await chain.chainNow();
      if (p.deadline <= now)
        throw new UserError("The commit deadline must be in the future.");
      const qs = new URLSearchParams({
        title: p.title,
        kind: p.kind,
        price: formatUnits(p.price, p.decimals),
        min: String(p.min),
        max: String(p.max),
        deadline: String(p.deadline),
        end: String(p.end),
        id: p.eventId.toString(),
      });
      if (p.minAmount > 0n)
        qs.set("budget", formatUnits(p.minAmount, p.decimals));
      const l = await link(`/api/tx/create?${qs}`);
      res.json({
        eventId: p.eventId.toString(),
        txUrl: l.txPath,
        solanaUrl: l.solanaUrl,
        qr: l.qr,
      });
    }),
  );

  app.get(
    "/api/pledge-link/:event",
    wrap(async (req, res) => {
      const event = eventParam(req);
      const amount = await pledgeAmount(req, event);
      const e = await chain.mustGetEvent(event);
      if (e.kind !== "ticket")
        throw new UserError("Only ticket events can be backed.");
      const { decimals } = await chain.tokenInfo(new PublicKey(e.mint));
      const l = await link(
        `/api/tx/pledge/${event.toBase58()}?amount=${formatUnits(amount, decimals)}`,
      );
      res.json({ txUrl: l.txPath, solanaUrl: l.solanaUrl, qr: l.qr });
    }),
  );

  app.get(
    "/api/pass-link/:event",
    wrap(async (req, res) => {
      const event = eventParam(req);
      const { expiresAt, signature } = passParams(req);
      const e = await chain.getEvent(event);
      if (!e) throw new UserError("Event not found. It may have been closed after everyone got their money back.", 404);
      if (!e.doorKey)
        throw new UserError(
          "This event has no door screen yet; register this screen first.",
          409,
        );
      if (
        !verifyEd25519(
          new PublicKey(e.doorKey),
          passMessage(event, expiresAt),
          signature,
        )
      )
        throw new UserError(
          "This screen is not the registered door screen for the event.",
          409,
        );
      const now = await chain.chainNow();
      if (expiresAt < now || expiresAt > now + MAX_PASS_SECS)
        throw new UserError(
          "The pass expiry is outside the allowed window (check the clock).",
        );
      const l = await link(
        `/api/tx/pass/${event.toBase58()}?exp=${expiresAt}&sig=${bs58.encode(signature)}`,
      );
      res.set("Cache-Control", "no-store").json({
        solanaUrl: l.solanaUrl,
        qr: l.qr,
      });
    }),
  );

  app.get(
    "/api/door-link/:event",
    wrap(async (req, res) => {
      const event = eventParam(req);
      const key = parsePubkey(req.query.key, "door key");
      const l = await link(
        `/api/tx/door/${event.toBase58()}?key=${key.toBase58()}`,
      );
      res.json({ txUrl: l.txPath, solanaUrl: l.solanaUrl, qr: l.qr });
    }),
  );

  app.get(
    "/api/find/:eventId",
    wrap(async (req, res) => {
      const id = String(req.params.eventId);
      if (!/^\d{1,20}$/.test(id) || BigInt(id) > U64_MAX)
        throw new UserError("Invalid event id.");
      // ?organizer= from a browser wallet, else whoever requested the create tx.
      const candidates =
        typeof req.query.organizer === "string"
          ? [parsePubkey(req.query.organizer, "organizer").toBase58()]
          : [...(creators.get(BigInt(id).toString()) ?? [])];
      let e: EventView | null = null;
      for (const org of candidates) {
        e = await chain.findEvent(new PublicKey(org), BigInt(id));
        if (e) break;
      }
      res.set("Cache-Control", "no-store").json({
        found: !!e,
        address: e?.address ?? null,
        organizer: e?.organizer ?? null,
      });
    }),
  );

  app.get(
    "/api/events",
    wrap(async (_req, res) => {
      res.json(await listEvents());
    }),
  );

  app.get(
    "/api/event/:event",
    wrap(async (req, res) => {
      const e = await eventJson(eventParam(req));
      if (!e) throw new UserError("Event not found. It may have been closed after everyone got their money back.", 404);
      res.set("Cache-Control", "no-store").json(e);
    }),
  );

  app.get(
    "/api/event/:event/commitment/:participant",
    wrap(async (req, res) => {
      const event = eventParam(req);
      const who = parsePubkey(req.params.participant, "participant");
      const [c, p] = await Promise.all([
        chain.getCommitment(event, who),
        chain.getPledge(event, who),
      ]);
      res.set("Cache-Control", "no-store").json({
        exists: !!c,
        checkedIn: c?.checkedIn ?? false,
        pledged: p?.amount ?? null,
      });
    }),
  );

  // The mint authority pays for new token accounts itself, never the sponsor.
  const faucetLimits = new SponsorLimits(1, 40, 24 * 3_600_000);
  const faucetIps = new SponsorLimits(2, 40, 24 * 3_600_000);
  const faucetFile = resolve(process.env.DATA_DIR ?? "data", "faucet.json");
  faucetLimits.load(faucetFile);
  const faucetIpFile = resolve(process.env.DATA_DIR ?? "data", "faucet-ips.json");
  faucetIps.load(faucetIpFile);
  app.post(
    "/api/faucet",
    wrap(async (req, res) => {
      if (!config.faucetAuthority || !config.mint)
        throw new UserError("No test-token faucet on this server.", 404);
      const owner = parsePubkey(req.body?.account, "wallet address");
      if (
        !faucetLimits.allow(owner.toBase58()) ||
        !faucetIps.allow(`ip:${req.ip ?? "?"}`)
      )
        throw new UserError(
          "This wallet already got test tokens today (or the daily limit is reached).",
          429,
        );
      const mint = new PublicKey(config.mint);
      const payer = config.faucetAuthority;
      const { decimals } = await chain.tokenInfo(mint);
      const amount = 20n * 10n ** BigInt(decimals);
      const ata = await getOrCreateAssociatedTokenAccount(
        chain.connection,
        payer,
        mint,
        owner,
      );
      const signature = await mintTo(
        chain.connection,
        payer,
        mint,
        ata.address,
        config.faucetAuthority,
        amount,
      );
      faucetLimits.save(faucetFile);
      faucetIps.save(faucetIpFile);
      cache.clear();
      res.json({ signature, amount: `20 ${sym}` });
    }),
  );

  /** Relay for browser wallets that only sign (keeps the demo on our cluster). */
  app.post(
    "/api/send",
    wrap(async (req, res) => {
      if (config.cluster !== "localnet")
        throw new UserError("Not available on this cluster.", 404);
      const raw =
        typeof req.body?.transaction === "string" ? req.body.transaction : "";
      let bytes: Buffer;
      let recentBlockhash: string;
      try {
        bytes = Buffer.from(raw, "base64");
        recentBlockhash =
          VersionedTransaction.deserialize(bytes).message.recentBlockhash;
      } catch {
        throw new UserError(
          "transaction must be a base64 serialized transaction.",
        );
      }
      try {
        const signature = await chain.connection.sendRawTransaction(bytes, {
          preflightCommitment: "confirmed",
        });
        await confirmSent(signature, recentBlockhash);
        cache.clear();
        res.json({ signature });
      } catch (err) {
        if (err instanceof UserError) throw err;
        const logs = (err as { logs?: string[] }).logs ?? [];
        throw new UserError(
          chain.explain(String((err as Error).message), logs),
          422,
        );
      }
    }),
  );

  /** Bounded by the validity of the tx's own blockhash, not a fresh one. */
  async function confirmSent(signature: string, blockhash: string) {
    const giveUp = Date.now() + 120_000;
    for (;;) {
      const st = (await chain.connection.getSignatureStatuses([signature]))
        .value[0];
      if (st?.err)
        throw new UserError(
          `Transaction failed: ${JSON.stringify(st.err)}`,
          422,
        );
      if (
        st?.confirmationStatus === "confirmed" ||
        st?.confirmationStatus === "finalized"
      )
        return;
      const valid = (
        await chain.connection.isBlockhashValid(blockhash, {
          commitment: "confirmed",
        })
      ).value;
      if (!valid || Date.now() > giveUp) {
        // one last look: it may have landed just before the blockhash expired
        const last = (
          await chain.connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (last && !last.err && last.confirmationStatus) return;
        throw new UserError(
          "The transaction expired before it was confirmed. Please try again.",
          422,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function listEvents() {
    return cached("events", 2000, async () => {
      const [events, now] = await Promise.all([
        chain.allEvents(config.mint),
        chain.chainNow(),
      ]);
      const out: EventJson[] = [];
      for (const e of events) {
        const { decimals } = await chain
          .tokenInfo(new PublicKey(e.mint))
          .catch(() => ({ decimals: 6 }));
        out.push(enrich(e, now, decimals));
      }
      const rank = {
        OPEN: 0,
        GO: 1,
        "NO-GO": 2,
        DONE: 3,
        CANCELLED: 4,
      } as const;
      return out.sort(
        (a, b) =>
          rank[a.status] - rank[b.status] ||
          a.commitDeadline - b.commitDeadline,
      );
    });
  }
  const warm = () => void listEvents().catch(() => {});
  warm();
  setInterval(warm, 60_000).unref();

  app.use(
    "/brand",
    express.static(BRAND_DIR, { maxAge: "1d", fallthrough: true }),
  );
  app.use("/pitch", express.static(PITCH_DIR, { maxAge: "10m" }));
  // From node_modules, not a CDN: the door screen holds a signing key.
  const vendor: Record<string, string> = {
    "web3.iife.min.js":
      require.resolve("@solana/web3.js/lib/index.iife.min.js"),
    "nacl-fast.min.js": require.resolve("tweetnacl/nacl-fast.min.js"),
  };
  app.get("/vendor/:file", (req, res) => {
    const f = vendor[String(req.params.file)];
    if (!f) return res.sendStatus(404);
    res.sendFile(f, { maxAge: "7d" });
  });
  // 'unsafe-inline': the server-rendered pages carry their scripts inline.
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.get("/icon.svg", (_req, res) => {
    const f = resolve(BRAND_DIR, "favicon.svg");
    if (existsSync(f)) return res.sendFile(f, { maxAge: "1d" });
    res
      .type("image/svg+xml")
      .set("Cache-Control", "public, max-age=86400")
      .send(views.iconSvg);
  });

  app.get(
    "/",
    wrap(async (_req, res) => {
      let events: EventJson[] = [];
      let error: string | undefined;
      try {
        events = await listEvents();
      } catch (e) {
        error = `Could not reach the Solana cluster (${(e as Error).message}).`;
      }
      res.send(views.landingPage(ctx, events, error));
    }),
  );

  app.get("/new", (_req, res) => {
    res.send(views.newPage(ctx, !!config.mint));
  });

  const pageEvent = async (req: Request) => {
    const key = parsePubkey(req.params.event, "event address");
    const e = await eventJson(key);
    if (!e) throw new UserError("Event not found. It may have been closed after everyone got their money back.", 404);
    return { key, e };
  };

  app.get(
    "/e/:event",
    wrap(async (req, res) => {
      const { key, e } = await pageEvent(req);
      const path =
        e.action === "refund"
          ? `/api/tx/refund/${key.toBase58()}`
          : `/api/tx/commit/${key.toBase58()}`;
      const l = await link(path);
      if (e.action === "closed" || !e.appToken) l.qr = "";
      res.send(views.eventPage(ctx, e, l));
    }),
  );

  app.get(
    "/e/:event/ticket/:participant",
    wrap(async (req, res) => {
      const { key, e } = await pageEvent(req);
      const participant = parsePubkey(req.params.participant, "participant");
      const c = await chain.getCommitment(key, participant);
      res.send(
        views.ticketPage(
          ctx,
          e,
          participant.toBase58(),
          c,
          await link(
            `/api/tx/checkin/${key.toBase58()}/${participant.toBase58()}`,
          ),
        ),
      );
    }),
  );

  app.get(
    "/e/:event/door",
    wrap(async (req, res) => {
      const { e } = await pageEvent(req);
      res.set("Cache-Control", "no-store").send(views.doorPage(ctx, e));
    }),
  );

  app.get(
    "/e/:event/admin",
    wrap(async (req, res) => {
      const { key, e } = await pageEvent(req);
      const org =
        typeof req.query.organizer === "string" ? req.query.organizer : "";
      const method = e.kind === "ticket" ? "withdraw" : "sweep";
      res.send(
        views.adminPage(
          ctx,
          e,
          org,
          await link(`/api/tx/${method}/${key.toBase58()}`),
          e.canCancel && e.appToken
            ? await link(`/api/tx/cancel/${key.toBase58()}`)
            : null,
          e.action === "refund" && e.appToken && BigInt(e.vault ?? "0") === 0n
            ? await link(`/api/tx/close/${key.toBase58()}`)
            : null,
        ),
      );
    }),
  );

  app.use((req: Request, res: Response) => {
    if (req.path.startsWith("/api/"))
      res.status(404).json({ error: "not_found", message: "Not found." });
    else res.status(404).send(views.errorPage(ctx, 404, "Nothing here."));
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const user = err instanceof UserError;
    const status = user
      ? err.status
      : (err as { status?: number }).status === 400
        ? 400
        : 500;
    const message = user
      ? err.message
      : status === 400
        ? 'Malformed request body; expected JSON like {"account": "<pubkey>"}.'
        : "Something went wrong talking to Solana. Try again in a moment.";
    if (!user && status === 500) console.error(err);
    if (req.path.startsWith("/api/"))
      res
        .status(status)
        .json({ error: status < 500 ? "invalid" : "server", message });
    else res.status(status).send(views.errorPage(ctx, status, message));
  });

  return { app, chain };
}

function randomU64(): bigint {
  return randomBytes(8).readBigUInt64LE();
}

export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
