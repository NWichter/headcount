import type {
  Action,
  CommitmentView,
  EventView,
  PledgeView,
  Status,
} from "./chain.js";

export interface ViewContext {
  cluster: "localnet" | "devnet";
  rpcUrl: string;
  programId: string;
  symbol: string;
  sponsored: boolean;
  faucet?: boolean;
  brand: boolean;
}

export interface Verdict {
  big: string;
  sub: string;
}

export interface EventData extends EventView {
  status: Status;
  action: Action;
  go: boolean;
  canCancel: boolean;
  verdict: Verdict;
  now: number;
  decimals: number;
  priceText: string;
  withdrawnText: string;
  hasBudget: boolean;
  minAmountText: string;
  totalCommittedText: string;
  pledgedText: string;
  appToken: boolean;
  /** Token label: the app's symbol, or the shortened mint address otherwise. */
  unit: string;
  checkInOpen: boolean;
  vault?: string;
  vaultText?: string;
  commitments?: (CommitmentView & { amountText: string })[];
  pledges?: (PledgeView & { amountText: string })[];
}

export interface TxLink {
  txPath: string;
  solanaUrl: string;
  qr: string;
}

export const h = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const pct = (e: EventData) => {
  const scale = Math.max(
    e.maxParticipants || e.minParticipants,
    e.minParticipants,
    e.participants,
    1,
  );
  return {
    fill: Math.min(100, (e.participants / scale) * 100),
    tick: Math.min(100, (e.minParticipants / scale) * 100),
  };
};
/** Integer ratio on base units, no float amounts. */
const moneyPct = (e: EventData) => {
  const budget = BigInt(e.minAmount);
  const have = BigInt(e.totalCommitted);
  if (budget === 0n) return { fill: 0, tick: 100 };
  const scale = have > budget ? have : budget;
  return {
    fill: Number((have * 1000n) / scale) / 10,
    tick: Number((budget * 1000n) / scale) / 10,
  };
};
const explorer = (ctx: ViewContext, address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=${
    ctx.cluster === "devnet"
      ? "devnet"
      : `custom&customUrl=${encodeURIComponent(ctx.rpcUrl)}`
  }`;
const time = (ts: number, fmt = "long") =>
  `<time data-ts="${ts}" data-fmt="${fmt}" datetime="${new Date(ts * 1000).toISOString()}">${new Date(
    ts * 1000,
  )
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")} UTC</time>`;

const statusLabel: Record<Status, string> = {
  OPEN: "Open",
  GO: "GO",
  "NO-GO": "NO-GO",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** Also sent to the poller as JSON. */
export function verdict(
  e: EventView & {
    status: Status;
    action: Action;
    unit: string;
    budgetText: string;
    /** Money still missing to the budget ("" if reached or no budget). */
    moneyNeedText: string;
  },
): Verdict {
  const need = Math.max(0, e.minParticipants - e.participants);
  const budget = BigInt(e.minAmount) > 0n;
  const goal = budget
    ? `${e.minParticipants} people and ${e.budgetText} ${e.unit}`
    : `${e.minParticipants}`;
  switch (e.status) {
    case "CANCELLED":
      return {
        big: "Cancelled.",
        sub: "The organizer called it off. Everyone takes their money back, no questions asked.",
      };
    case "OPEN":
      return {
        big:
          need > 0
            ? `${need} more to GO`
            : `${e.moneyNeedText} ${e.unit} to GO`,
        sub: budget
          ? need > 0 && e.moneyNeedText
            ? `Needs ${need} more ${need === 1 ? "person" : "people"} and ${e.moneyNeedText} ${e.unit} more by the deadline. Backers can pay for the pizza, but they can't fake the headcount.`
            : need > 0
              ? `The budget is covered; it still needs ${need} more ${need === 1 ? "person" : "people"}. Backers can pay for the pizza, but they can't fake the headcount.`
              : `Enough people are in; the budget still needs ${e.moneyNeedText} ${e.unit}. Back it, or bring a friend.`
          : `If it doesn't reach ${e.minParticipants} by the deadline, everyone gets their money back.`,
      };
    case "GO":
      return {
        big: "It's GO.",
        sub:
          e.action === "commit"
            ? e.kind === "ticket"
              ? "The headcount is reached. It's happening. There's still time to join."
              : "It's happening. Show up, check in at the door, get your deposit back."
            : "Commitments are closed. See you there.",
      };
    case "NO-GO":
      return {
        big: "NO-GO.",
        sub: `It didn't reach ${goal} by the deadline. ${e.kind === "deposit" ? "Every deposit is refundable." : "Every ticket and pledge is refundable."} Take yours back.`,
      };
    case "DONE":
      if (e.action === "refund")
        return {
          big: "Didn't happen.",
          sub: "Nobody was checked in, so every deposit goes back. Take yours.",
        };
      return {
        big: "Done.",
        sub:
          e.kind === "deposit"
            ? `${e.checkedIn} of ${e.participants} showed up. The no-shows paid for the pizza.`
            : "This event is over. Thanks for committing.",
      };
  }
}

const CSS = /* css */ `
:root{
  --paper:#f2ede1;--paper-2:#e8e0cc;--ink:#12110f;--ink-2:#2b2925;--muted:#6d665a;--line:#d5cab2;
  --card:#fffcf5;--open:#2a4dff;--on-open:#fff;--go:#b9f43c;--go-ink:#0f1a00;--nogo:#ff4a1d;--on-nogo:#fff;
  --done:#8b8575;--accent:var(--open);--on-accent:var(--on-open);
  --radius:20px;--shadow:0 1px 0 rgba(0,0,0,.04),0 18px 40px -22px rgba(50,35,5,.45);
  --display:"Anton",Impact,"Arial Narrow",sans-serif;
  --sans:"Bricolage Grotesque",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0e0d0b;--paper-2:#181713;--ink:#f2ede1;--ink-2:#d8d1c1;--muted:#a09a8b;--line:#2e2c26;
  --card:#181713;--open:#8198ff;--on-open:#0b0d1f;--go:#c6ff4f;--nogo:#ff6a3d;--on-nogo:#1a0600;--done:#7c776a;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 18px 40px -22px rgba(0,0,0,.9);
}}
[data-status="GO"]{--accent:var(--go);--on-accent:var(--go-ink)}
[data-status="NO-GO"]{--accent:var(--nogo);--on-accent:var(--on-nogo)}
[data-status="DONE"],[data-status="CANCELLED"]{--accent:var(--done);--on-accent:var(--paper)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.5 var(--sans);min-height:100vh;
  background-image:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--ink) 7%,transparent) 1px,transparent 0);
  background-size:22px 22px;overflow-x:hidden}
a{color:inherit}
img,svg{max-width:100%}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
.marquee{background:#12110f;color:rgba(242,237,225,.65);overflow:hidden;white-space:nowrap;font:400 12px/1 var(--display);
  letter-spacing:.14em;text-transform:uppercase;padding:7px 0}
.marquee div{display:flex;width:max-content;animation:marquee 90s linear infinite}
.marquee:hover div{animation-play-state:paused}
.marquee span{flex:none}
.marquee b{color:#c6ff4f;font-weight:400;margin:0 .9em}
@keyframes marquee{to{transform:translateX(-50%)}}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0}
.logo{text-decoration:none;display:inline-flex;align-items:center}
.logo img{display:block;height:29px;width:auto}
.wordmark{font:400 28px/1 var(--display);letter-spacing:.02em;text-transform:uppercase}
.btn{appearance:none;border:2px solid var(--ink);background:var(--ink);color:var(--paper);font:700 16px/1 var(--sans);
  padding:14px 20px;border-radius:999px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;
  justify-content:center;gap:8px;transition:transform .12s ease,box-shadow .12s ease;min-height:48px}
.btn:hover{transform:translateY(-2px);box-shadow:0 6px 0 -1px var(--accent)}
.btn:active{transform:translateY(0)}
.btn.ghost{background:transparent;color:var(--ink)}
.btn.accent{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.sm{padding:9px 14px;min-height:38px;font-size:14px;white-space:nowrap}
.btn[disabled]{opacity:.55;cursor:progress;transform:none}
.chip{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;
  padding:7px 10px;border-radius:999px;border:1.5px solid var(--ink);white-space:nowrap}
.chip.s-OPEN{background:var(--open);border-color:var(--open);color:var(--on-open)}
.chip.s-GO{background:var(--go);border-color:var(--go);color:var(--go-ink)}
.chip.s-NO-GO{background:var(--nogo);border-color:var(--nogo);color:var(--on-nogo)}
.chip.s-DONE{background:transparent;border-color:var(--done);color:var(--done)}
.chip.s-CANCELLED{background:var(--ink);border-color:var(--ink);color:var(--paper);text-decoration:line-through}
.chip.s-OPEN::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 1.4s infinite}
@keyframes pulse{50%{opacity:.25}}
.bar{position:relative;height:18px;border:2px solid var(--ink);border-radius:999px;background:var(--card);overflow:visible}
.bar>i{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--accent);transition:width .8s cubic-bezier(.2,.9,.2,1.2)}
.bar>.tick{position:absolute;top:-7px;bottom:-7px;width:3px;margin-left:-1.5px;background:var(--ink);border-radius:2px}
.bar>.tick::after{content:"MIN";position:absolute;top:-17px;left:50%;transform:translateX(-50%);font:600 10px/1 var(--mono);letter-spacing:.1em}
.mono{font-family:var(--mono)}
.muted{color:var(--muted)}
.card{background:var(--card);border:2px solid var(--ink);border-radius:var(--radius);box-shadow:var(--shadow)}
h1,h2,h3{margin:0}
.kicker{font:600 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
footer.foot{margin:64px 0 0;padding:28px 0 40px;border-top:2px solid var(--ink);display:flex;flex-wrap:wrap;gap:10px 24px;
  justify-content:space-between;font-size:13px;color:var(--muted)}
footer.foot a{color:var(--muted)}
.toast{visibility:hidden;position:fixed;left:50%;bottom:20px;transform:translate(-50%,140%);max-width:min(560px,calc(100% - 32px));
  background:var(--ink);color:var(--paper);padding:14px 18px;border-radius:14px;font-weight:600;z-index:50;
  transition:transform .3s cubic-bezier(.2,.9,.2,1.1);box-shadow:0 12px 30px -10px rgba(0,0,0,.5)}
.toast.show{transform:translate(-50%,0);visibility:visible}
.toast.error{background:var(--nogo);color:var(--on-nogo)}
.confetti{position:fixed;top:-20px;width:10px;height:16px;z-index:60;pointer-events:none;border-radius:2px}

/* landing */
.hero{padding:28px 0 12px}
.hero h1{font:400 clamp(52px,13.5vw,168px)/.98 var(--display);text-transform:uppercase;letter-spacing:-.01em;margin:8px 0 18px}
.hero h1 .hl{background:var(--go);color:var(--go-ink);padding:0 .08em;border-radius:.06em;display:inline-block;transform:rotate(-2deg);line-height:.9;margin:.04em 0}
.hero h1 .st{-webkit-text-stroke:2px var(--ink);color:transparent}
.hero p.lead{font-size:clamp(18px,4.6vw,24px);line-height:1.35;max-width:36ch;margin:0 0 22px;font-weight:500}
.hero .cta{display:flex;flex-wrap:wrap;gap:10px}
.steps{display:grid;grid-template-columns:1fr;gap:12px;margin:40px 0 8px;counter-reset:s}
.step{padding:18px 18px 20px;position:relative}
.step b{font:400 44px/1 var(--display);display:block;margin-bottom:8px}
.step:nth-child(1) b{color:var(--open)}
.step:nth-child(2) b{color:var(--ink);background:var(--go);display:inline-block;padding:2px 8px 0;border-radius:8px}
.step:nth-child(3) b{color:var(--nogo)}
.step p{margin:0;color:var(--ink-2)}
.section-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:48px 0 16px}
.section-head h2{font:400 clamp(34px,8vw,56px)/.95 var(--display);text-transform:uppercase}
.grid{display:grid;grid-template-columns:1fr;gap:14px}
.ev{display:block;text-decoration:none;padding:18px;position:relative;overflow:hidden;transition:transform .15s ease}
.ev:hover{transform:translateY(-3px) rotate(-.3deg)}
.ev .row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:14px}
.ev h3{font:800 clamp(22px,6vw,28px)/1.1 var(--sans);letter-spacing:-.02em;margin-bottom:6px;overflow-wrap:anywhere}
.ev .meta{font-size:14px;color:var(--muted);margin-bottom:26px}
.ev .num{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;font:600 13px/1 var(--mono)}
.ev .num strong{font:400 30px/1 var(--display);letter-spacing:.02em}
.ev[data-status="GO"]{background:var(--go);color:var(--go-ink);border-color:var(--go-ink)}
.ev[data-status="GO"] .meta{color:color-mix(in srgb,var(--go-ink) 70%,transparent)}
.ev[data-status="GO"] .bar{border-color:var(--go-ink);background:transparent}
.ev[data-status="GO"] .bar>i{background:var(--go-ink)}
.ev[data-status="GO"] .bar>.tick{background:var(--go-ink)}
.ev[data-status="GO"] .chip.kind{border-color:var(--go-ink)}
.ev[data-status="GO"] .chip.s-GO,.ticket .top .chip.s-GO{background:var(--go-ink);border-color:var(--go-ink);color:var(--go)}
.ev[data-status="NO-GO"] h3{text-decoration:line-through;text-decoration-thickness:3px;text-decoration-color:var(--nogo)}
.ev[data-status="DONE"],.ev[data-status="CANCELLED"]{opacity:.7}
.ev[data-status="CANCELLED"] h3{text-decoration:line-through;text-decoration-thickness:3px}
.empty{padding:28px;text-align:center}
.empty p{margin:0 0 14px}

/* event page */
.event{display:grid;grid-template-columns:1fr;gap:18px;padding-top:6px}
.event>*{min-width:0}
.poster{padding:22px 18px 24px;position:relative;overflow:hidden}
.poster .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.poster h1{font:400 clamp(46px,13vw,104px)/.9 var(--display);text-transform:uppercase;overflow-wrap:anywhere;margin-bottom:14px}
.poster .price{font-size:18px;margin:0 0 34px;color:var(--ink-2)}
.poster .price b{font-family:var(--mono);background:var(--ink);color:var(--paper);padding:2px 8px;border-radius:6px}
.counter{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:22px}
.counter .big{font:400 clamp(96px,30vw,176px)/.8 var(--display);letter-spacing:-.02em;transition:transform .3s}
.counter .big.bump{animation:bump .6s cubic-bezier(.2,.9,.2,1.4)}
@keyframes bump{30%{transform:scale(1.18) rotate(-3deg)}}
.counter .of{font:400 clamp(40px,11vw,64px)/.8 var(--display);color:var(--muted)}
.counter .lbl{font:600 13px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted);flex-basis:100%}
.verdict{margin:26px 0 0;padding:18px;border-radius:16px;background:var(--accent);color:var(--on-accent);position:relative}
.verdict strong{display:block;font:400 clamp(40px,12vw,72px)/.9 var(--display);text-transform:uppercase}
.verdict span{display:block;margin-top:8px;font-weight:600}
[data-status="GO"] .verdict{transform:rotate(-1.2deg);box-shadow:6px 6px 0 var(--ink)}
[data-status="GO"] .poster{border-color:var(--go-ink)}
[data-status="GO"] body,[data-status="GO"]{--glow:1}
.stamp{position:absolute;right:10px;top:20px;transform:rotate(12deg);font:400 16px/1 var(--display);letter-spacing:.1em;
  border:3px solid var(--nogo);color:var(--nogo);padding:6px 12px 4px;border-radius:8px;opacity:.9}
.countdown{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:22px}
.countdown div{border:2px solid var(--ink);border-radius:12px;text-align:center;padding:8px 0 6px;background:var(--paper)}
.countdown b{display:block;font:400 clamp(28px,9vw,40px)/1 var(--display);font-variant-numeric:tabular-nums}
.countdown small{font:600 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.when{margin-top:10px;font-size:14px;color:var(--muted)}
.stub{padding:20px 18px 22px;position:relative}
.stub::before,.stub::after{content:"";position:absolute;left:-2px;right:-2px;height:0;border-top:2px dashed var(--line)}
.stub::before{top:62px}
.stub::after{display:none}
.stub h2{font:400 30px/1 var(--display);text-transform:uppercase;margin-bottom:28px}
.qr{background:#fff;border-radius:16px;padding:14px;border:2px solid var(--ink);width:min(100%,340px);margin:0 auto 14px;aspect-ratio:1}
.qr svg{display:block;width:100%;height:100%}
.stub .hint{text-align:center;font-size:14px;color:var(--muted);margin:0 0 16px}
.stub .btn{width:100%}
.stub .or{display:flex;align-items:center;gap:10px;color:var(--muted);font:600 11px/1 var(--mono);letter-spacing:.14em;margin:14px 0}
.stub .or::before,.stub .or::after{content:"";flex:1;border-top:1.5px solid var(--line)}
.fine{font-size:13px;color:var(--muted);margin:14px 0 0}
.fine a{color:var(--muted)}
.find{display:flex;gap:8px;margin-top:10px}
.find .btn{width:auto;flex:none}
.ticket .top .chip{border-color:currentColor}
.find input{flex:1;min-width:0}
.feed{margin-top:18px;padding:18px}
.feed h3{font:400 24px/1 var(--display);text-transform:uppercase;margin-bottom:12px}
.feed ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.feed li a,.feed li span{display:inline-block;font:500 13px/1 var(--mono);padding:8px 10px;border-radius:999px;border:1.5px solid var(--line);text-decoration:none}
.feed li .in{background:var(--go);color:var(--go-ink);border-color:var(--go)}
/* budget + backers */
.meter{margin-top:22px}
.meter .mlbl{display:flex;justify-content:space-between;gap:10px;font:600 12px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:24px}
.bar.money>i{background:repeating-linear-gradient(-45deg,var(--accent) 0 8px,color-mix(in srgb,var(--accent) 70%,var(--card)) 8px 16px)}
.bar.money>.tick::after{content:"BUDGET";left:auto;right:-2px;transform:none}
.ev .num.money{margin-top:8px;font-size:12px;color:var(--muted)}
.back{margin-top:18px;padding:20px 18px}
.back h3{font:400 28px/1 var(--display);text-transform:uppercase;margin-bottom:10px}
.back h3 small{font:600 13px/1 var(--mono);letter-spacing:.08em;color:var(--muted)}
.back .quote{font-weight:800;font-size:18px;border-left:4px solid var(--go);padding-left:12px}
.pill-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 14px}
.faucet{border:1px dashed currentColor;border-radius:12px;padding:10px 12px;margin:0 0 14px;opacity:.9}.faucet-row{display:flex;flex-wrap:wrap;gap:8px}.faucet-row input{flex:1 1 200px;min-width:0;font:inherit;padding:8px 10px;border-radius:10px;border:1px solid currentColor;background:transparent;color:inherit}.faucet output{display:block;margin-top:6px}.faucet-row .btn{width:auto;flex:1 1 auto}
.pill{display:inline-block;font:600 12px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;background:var(--go);color:var(--go-ink);padding:7px 10px;border-radius:999px}
/* door screen */
.door-title{font:400 clamp(40px,10vw,88px)/.9 var(--display);text-transform:uppercase;overflow-wrap:anywhere;margin:10px 0 18px}
.door-grid{display:grid;grid-template-columns:1fr;gap:18px}
.door-grid>*{min-width:0}
.door-pass,.door-stats{padding:20px 18px 22px}
.door-pass h2{font:400 30px/1 var(--display);text-transform:uppercase;margin-bottom:16px}
.qr.big{width:min(100%,560px)}
.renew{height:8px;border:2px solid var(--ink);border-radius:999px;overflow:hidden;max-width:560px;margin:0 auto}
.renew i{display:block;height:100%;background:var(--accent);width:100%;transition:width .25s linear}
.door-count{display:flex;align-items:baseline;gap:10px}
.door-count b{font:400 clamp(96px,26vw,180px)/.8 var(--display)}
.door-count span{font:400 clamp(36px,9vw,60px)/.8 var(--display);color:var(--muted)}
.door-state{font-weight:700;font-size:18px}

/* forms */
form.new{padding:20px 18px;display:grid;gap:18px}
label.f{display:grid;gap:6px;font-weight:700}
label.f small{font-weight:400;color:var(--muted)}
input,select{font:500 17px/1.2 var(--sans);color:var(--ink);background:var(--paper);border:2px solid var(--ink);border-radius:12px;
  padding:12px 14px;width:100%;min-height:48px}
input:focus,select:focus{outline:3px solid var(--accent);outline-offset:1px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.kinds{display:grid;grid-template-columns:1fr;gap:10px;border:0;padding:0;margin:0}
.kinds legend{font-weight:700;margin-bottom:6px;padding:0}
.kinds label{display:block;border:2px solid var(--ink);border-radius:14px;padding:14px 14px 14px 46px;position:relative;cursor:pointer;background:var(--paper)}
.kinds input{position:absolute;left:14px;top:16px;width:20px;height:20px;min-height:0;accent-color:var(--ink)}
.kinds label:has(input:checked){background:var(--ink);color:var(--paper)}
.kinds b{display:block;font:400 22px/1 var(--display);text-transform:uppercase;margin-bottom:4px}
.kinds span{font-size:14px;opacity:.85}
.presets{display:flex;flex-wrap:wrap;gap:6px}
.presets button{font:600 12px/1 var(--mono);border:1.5px solid var(--ink);background:transparent;color:var(--ink);border-radius:999px;padding:7px 10px;cursor:pointer}
.err{background:var(--nogo);color:var(--on-nogo);border-radius:12px;padding:12px 14px;font-weight:600}

/* admin */
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0}
.stat{padding:14px}
.stat b{display:block;font:400 34px/1 var(--display)}
.stat small{font:600 11px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
table.list{width:100%;border-collapse:collapse;font-size:14px}
table.list th{text-align:left;font:600 11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:10px 8px;border-bottom:2px solid var(--ink)}
table.list td{padding:10px 6px;border-bottom:1.5px solid var(--line);vertical-align:middle}
table.list td:last-child{text-align:right}
@media (max-width:480px){table.list .amt{display:none}table.list .chip{padding:6px 7px;font-size:11px}}
.warn{border:2px dashed var(--nogo);border-radius:14px;padding:12px 14px;margin:14px 0;font-weight:600}

/* ticket */
.ticket{max-width:460px;margin:8px auto 0;padding:0;overflow:hidden}
.ticket .top{padding:22px 20px 18px;background:var(--accent);color:var(--on-accent);position:relative}
.ticket .top h1{font:400 clamp(36px,11vw,56px)/.9 var(--display);text-transform:uppercase;overflow-wrap:anywhere;margin:10px 0 8px}
.ticket .perf{height:0;border-top:3px dashed var(--ink);position:relative;margin:0 16px}
.ticket .perf::before,.ticket .perf::after{content:"";position:absolute;top:-15px;width:28px;height:28px;border-radius:50%;background:var(--paper);border:2px solid var(--ink)}
.ticket .perf::before{left:-32px}
.ticket .perf::after{right:-32px}
.ticket .body{padding:22px 20px 24px}
.ticket .state{text-align:center;font:400 30px/1 var(--display);text-transform:uppercase;margin:6px 0 14px}
.ticket .state.ok{background:var(--go);color:var(--go-ink);border-radius:12px;padding:16px 10px 12px;transform:rotate(-2deg)}

@media (min-width:720px){
  .steps{grid-template-columns:repeat(3,1fr)}
  .grid{grid-template-columns:repeat(2,1fr)}
  .stats{grid-template-columns:repeat(4,1fr)}
  .kinds{grid-template-columns:1fr 1fr}
  .poster{padding:34px 34px 36px}
  .stub{padding:24px 26px 28px}
}
@media (min-width:980px){
  .grid{grid-template-columns:repeat(3,1fr)}
  .door-grid{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start}
  .event{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);align-items:start}
  .stub{position:sticky;top:16px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
}
`;

const CLIENT_JS = /* js */ `
window.GN = (function(){
  var cfg = window.GN_CFG || {};
  function toast(msg, kind){
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show' + (kind === 'error' ? ' error' : '');
    clearTimeout(t._h); t._h = setTimeout(function(){ t.className = 'toast'; }, kind === 'error' ? 7000 : 4500);
  }
  function provider(){ return (window.phantom && window.phantom.solana) || window.solana || null; }
  async function connect(){
    var p = provider();
    if (!p) throw new Error('No browser wallet found. Scan the QR code with Phantom on your phone instead.');
    var r = await p.connect();
    var pk = (r && r.publicKey) || p.publicKey;
    return { p: p, pk: pk.toString() };
  }
  function b64ToBytes(s){ var bin = atob(s), out = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }
  function bytesToB64(b){ var s=''; for (var i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
  async function run(txPath, btn, onDone){
    var label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting for wallet…'; }
    try {
      if (!window.solanaWeb3) throw new Error('Could not load @solana/web3.js. Scan the QR code instead.');
      var c = await connect();
      var r = await fetch(txPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: c.pk }) });
      var j = await r.json();
      if (!r.ok) throw new Error(j.message || 'Request failed');
      var tx = solanaWeb3.Transaction.from(b64ToBytes(j.transaction));
      if (btn) btn.textContent = 'Sign in your wallet…';
      var sig;
      if (cfg.cluster === 'localnet' && c.p.signTransaction) {
        var signed = await c.p.signTransaction(tx);
        if (btn) btn.textContent = 'Sending…';
        var s = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: bytesToB64(signed.serialize()) }) });
        var sj = await s.json();
        if (!s.ok) throw new Error(sj.message || 'Sending failed');
        sig = sj.signature;
      } else {
        var out = await c.p.signAndSendTransaction(tx);
        sig = out.signature;
      }
      if (onDone) onDone(c.pk, sig, j.message);
      return sig;
    } catch (e) {
      toast((e && e.message) || String(e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }
  function confetti(){
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var cs = getComputedStyle(document.documentElement);
    var colors = ['--go','--open','--nogo','--ink'].map(function(v){ return cs.getPropertyValue(v).trim(); });
    for (var i = 0; i < 110; i++) {
      var d = document.createElement('i'); d.className = 'confetti';
      d.style.left = (Math.random() * 100) + 'vw';
      d.style.background = colors[i % colors.length];
      document.body.appendChild(d);
      var x = (Math.random() - .5) * 240, rot = Math.random() * 900;
      d.animate([{ transform: 'translate(0,0) rotate(0)' }, { transform: 'translate(' + x + 'px,' + (innerHeight + 60) + 'px) rotate(' + rot + 'deg)' }],
        { duration: 1800 + Math.random() * 1600, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.6,.4,1)' }).onfinish = (function(el){ return function(){ el.remove(); }; })(d);
    }
  }
  function fmtTime(ts, fmt){
    var d = new Date(ts * 1000);
    return d.toLocaleString('en-GB', fmt === 'short' ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function localizeTimes(root){
    (root || document).querySelectorAll('time[data-ts]').forEach(function(t){ t.textContent = fmtTime(+t.dataset.ts, t.dataset.fmt); });
  }
  function relative(sec){
    var a = Math.abs(sec), s;
    if (a < 90) s = Math.round(a) + ' s'; else if (a < 5400) s = Math.round(a/60) + ' min';
    else if (a < 172800) s = Math.round(a/3600) + ' h'; else s = Math.round(a/86400) + ' days';
    return sec >= 0 ? 'in ' + s : s + ' ago';
  }
  document.addEventListener('DOMContentLoaded', function(){ localizeTimes(); });
  return { toast: toast, run: run, connect: connect, confetti: confetti, localizeTimes: localizeTimes, relative: relative, fmtTime: fmtTime };
})();
`;

interface LayoutOpts {
  title: string;
  body: string;
  status?: Status;
  web3?: boolean;
  scripts?: string[];
  script?: string;
  description?: string;
  /** The scrolling tagline band; only on the home page. */
  ticker?: boolean;
}

const TAGLINE = "The event happens when the headcount does.";

function logo(ctx: ViewContext) {
  return ctx.brand
    ? `<picture><source srcset="/brand/headcount-logo-dark.svg" media="(prefers-color-scheme: dark)"><img src="/brand/headcount-logo.svg" alt="Headcount" width="165" height="29"></picture>`
    : `<span class="wordmark">Headcount</span>`;
}

function layout(ctx: ViewContext, o: LayoutOpts) {
  const marquee =
    "The event happens when the headcount does <b>✦</b> Otherwise everyone gets their money back <b>✦</b> Enforced on Solana <b>✦</b> No-shows pay for the pizza <b>✦</b> Backers can pay for the pizza, not fake the headcount <b>✦</b> ";
  const icons = ctx.brand
    ? `<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon-180.png">`
    : `<link rel="icon" href="/icon.svg" type="image/svg+xml">`;
  const scripts = [
    ...(o.web3 ? ["/vendor/web3.iife.min.js"] : []),
    ...(o.scripts ?? []),
  ];
  return `<!doctype html>
<html lang="en"${o.status ? ` data-status="${o.status}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(o.title)}</title>
<meta name="description" content="${h(o.description ?? `${TAGLINE} Otherwise everyone gets their money back, by rules enforced on Solana.`)}">
<meta name="theme-color" content="#f2ede1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e0d0b" media="(prefers-color-scheme: dark)">
${icons}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
${scripts.map((s) => `<script src="${s}" defer></script>`).join("\n")}
<script>window.GN_CFG=${json({ cluster: ctx.cluster })};${CLIENT_JS}</script>
</head>
<body>
${o.ticker ? `<div class="marquee" aria-hidden="true"><div><span>${marquee.repeat(3)}</span><span>${marquee.repeat(3)}</span></div></div>` : ""}
<div class="wrap">
<header class="top">
  <a class="logo" href="/" aria-label="Headcount home">${logo(ctx)}</a>
  <a class="btn sm ghost" href="/new">+ New event</a>
</header>
${o.body}
<footer class="foot">
  <span>Headcount · money held by a Solana program, not by us.</span>
  <span>${h(ctx.cluster)} · program <a href="${h(explorer(ctx, ctx.programId))}" target="_blank" rel="noopener" class="mono">${short(ctx.programId)}</a></span>
</footer>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
${o.script ? `<script>${o.script}</script>` : ""}
</body>
</html>`;
}

function progress(e: EventData) {
  const p = pct(e);
  return `<div class="bar" id="people-bar" role="progressbar" aria-label="People" aria-valuemin="0" aria-valuemax="${e.minParticipants}" aria-valuenow="${e.participants}">
  <i style="width:${p.fill.toFixed(1)}%"></i><span class="tick" style="left:${p.tick.toFixed(1)}%"></span></div>`;
}

function moneyBar(e: EventData) {
  const p = moneyPct(e);
  return `<div class="bar money" id="money-bar" role="progressbar" aria-label="Budget">
  <i style="width:${p.fill.toFixed(1)}%"></i><span class="tick" style="left:${p.tick.toFixed(1)}%"></span></div>`;
}

function meters(e: EventData) {
  if (!e.hasBudget) return progress(e);
  return `<div class="meter"><div class="mlbl"><span>People</span><span id="m-people">${e.participants} / ${e.minParticipants}</span></div>${progress(e)}</div>
  <div class="meter"><div class="mlbl"><span>Budget</span><span id="m-money">${h(e.totalCommittedText)} / ${h(e.minAmountText)} ${h(e.unit)}</span></div>${moneyBar(e)}</div>
  <p class="fine" id="m-backers">${backersLine(e)}</p>`;
}

function backersLine(e: EventData) {
  return e.backers
    ? `${e.backers} ${e.backers === 1 ? "backer" : "backers"} pledged ${h(e.pledgedText)} ${h(e.unit)}. Backers can pay for the pizza, but they can't fake the headcount.`
    : "Backers can pay for the pizza, but they can't fake the headcount.";
}

function kindLabel(e: EventView) {
  return e.kind === "ticket" ? "Ticket" : "Deposit";
}

function sponsoredPill(ctx: ViewContext) {
  return ctx.sponsored
    ? `<p class="pill-row"><span class="pill">No SOL needed</span> <span class="fine" style="margin:0">Network fees are covered.</span></p>`
    : "";
}

function faucetBlock(ctx: ViewContext) {
  if (!ctx.faucet) return "";
  return `<form class="faucet" onsubmit="event.preventDefault();(async f=>{const o=f.querySelector('output');o.textContent='Sending…';try{const r=await fetch('/api/faucet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:f.account.value.trim()})});const j=await r.json();o.textContent=r.ok?'Sent '+j.amount+' to your wallet.':(j.error||'Failed.');}catch(e){o.textContent='Failed.';}})(this)">
  <p class="fine" style="margin:0 0 6px"><b>Trying the ${h(ctx.cluster)} demo?</b> Get 20 test ${h(ctx.symbol)} for your wallet (switch it to ${h(ctx.cluster)}).</p>
  <div class="faucet-row"><input name="account" placeholder="Your wallet address" autocomplete="off" required><button class="btn" type="submit">Get test ${h(ctx.symbol)}</button></div>
  <output class="fine"></output>
</form>`;
}

function stubBlock(opts: {
  heading: string;
  link: TxLink;
  button: string;
  buttonId: string;
  hint?: string;
  before?: string;
  after?: string;
}) {
  return `<h2>${opts.heading}</h2>
  ${opts.before ?? ""}
  <div class="qr" title="Solana Pay transaction request">${opts.link.qr}</div>
  <p class="hint">${opts.hint ?? "Scan with Phantom or any Solana Pay wallet"}</p>
  <div class="or">OR ON THIS DEVICE</div>
  <button class="btn accent" id="${opts.buttonId}" data-tx="${h(opts.link.txPath)}">${opts.button}</button>
  <p class="fine" style="text-align:center">On your phone? <a href="${h(opts.link.solanaUrl)}">Open in wallet app</a></p>
  ${opts.after ?? ""}`;
}

function tokenWarning(e: EventData) {
  return e.appToken
    ? ""
    : `<div class="warn">This event uses a different token than this app: mint <span class="mono" style="overflow-wrap:anywhere">${h(e.mint)}</span>. Amounts are in that token's units, not the app's stablecoin. Transactions for it are refused here.</div>`;
}

export function landingPage(
  ctx: ViewContext,
  events: EventData[],
  error?: string,
) {
  const cards = events
    .map((e) => {
      const deadlineIn = e.commitDeadline - e.now;
      const peopleNeed = Math.max(0, e.minParticipants - e.participants);
      return `<a class="ev card" href="/e/${e.address}" data-status="${e.status}">
  <div class="row"><span class="chip kind">${kindLabel(e)}</span><span class="chip s-${e.status}">${statusLabel[e.status]}</span></div>
  <h3>${h(e.title)}</h3>
  <div class="meta">${h(e.priceText)} ${h(e.unit)} ${e.kind === "ticket" ? "ticket" : "deposit"} · ${
    deadlineIn > 0
      ? `closes <span data-rel="${e.commitDeadline}">${time(e.commitDeadline, "short")}</span>`
      : `closed ${time(e.commitDeadline, "short")}`
  }</div>
  ${progress(e)}
  <div class="num"><span><strong>${e.participants}</strong>${e.participants >= e.minParticipants ? ` committed · min ${e.minParticipants}` : ` / ${e.minParticipants} committed`}</span><span>${
    e.status === "OPEN"
      ? peopleNeed > 0
        ? `${peopleNeed} to go`
        : "budget to go"
      : e.action === "refund"
        ? "refunds open"
        : e.status === "GO"
          ? "happening"
          : "over"
  }</span></div>
  ${e.hasBudget ? `<div class="num money"><span>${h(e.totalCommittedText)} / ${h(e.minAmountText)} ${h(e.unit)} budget</span><span>${e.backers ? `${e.backers} ${e.backers === 1 ? "backer" : "backers"}` : ""}</span></div>` : ""}
</a>`;
    })
    .join("\n");

  const body = `
<section class="hero">
  <div class="kicker">Commitment-backed events on Solana</div>
  <h1>The event <span class="hl">happens</span> when the headcount <span class="st">does.</span></h1>
  <p class="lead">Everyone commits money by a deadline. Enough people: it's GO. Not enough: everyone gets their money back, by rules enforced on Solana. No organizer can run off with it, no refund forms.</p>
  <div class="cta"><a class="btn accent" href="/new">Start an event</a><a class="btn ghost" href="#events">See what's on</a></div>
  <div class="steps">
    <div class="step card"><b>1 · Commit</b><p>Pay the ticket, or lock a small deposit, into a vault owned by the event. Not by the organizer. Backers can chip in money without taking a seat.</p></div>
    <div class="step card"><b>2 · GO</b><p>Headcount (and budget) reached by the deadline? It's on. The organizer gets paid; at the door, attendees scan the door screen and their deposit comes back.</p></div>
    <div class="step card"><b>3 · NO-GO</b><p>Missed it? Everyone refunds themselves on-chain. Backers can pay for the pizza, but they can't fake the headcount.</p></div>
  </div>
</section>
<section id="events">
  <div class="section-head"><h2>On the board</h2><span class="kicker">${events.length} event${events.length === 1 ? "" : "s"}</span></div>
  ${error ? `<div class="err">${h(error)}</div>` : ""}
  ${
    events.length
      ? `<div class="grid">${cards}</div>`
      : error
        ? ""
        : `<div class="empty card"><p><b>Nothing on the board yet.</b></p><a class="btn accent" href="/new">Create the first event</a></div>`
  }
</section>`;
  return layout(ctx, {
    title: `Headcount · ${TAGLINE}`,
    ticker: true,
    body,
    script: `document.querySelectorAll('[data-rel]').forEach(function(el){ el.textContent = GN.relative(+el.dataset.rel - Date.now()/1000); });`,
  });
}

/** Pledge flow (ticket events). */
function backBlock(ctx: ViewContext, e: EventData) {
  return `<section class="card back" id="back">
  <h3>Back this event <small>(no seat)</small></h3>
  <p>${
    e.hasBudget
      ? `Help close the budget gap without taking a seat. Your pledge counts toward the ${h(e.minAmountText)} ${h(e.unit)} budget, never toward the headcount.`
      : "Chip in money for the organizer without taking a seat. Pledges never count toward the headcount."
  } If the event does not happen, you take it back yourself.</p>
  <p class="quote">Backers can pay for the pizza, but they can't fake the headcount.</p>
  <form class="find" id="pledge-form"><input name="amount" inputmode="decimal" placeholder="Amount in ${h(ctx.symbol)}" aria-label="Pledge amount" autocomplete="off" value="${h(e.priceText)}"><button class="btn sm">Pledge</button></form>
  <div id="pledge-out" hidden>
    <div class="qr" id="pledge-qr" style="max-width:260px;margin-top:14px"></div>
    <p class="hint">Scan with the wallet you back from</p>
    <button class="btn accent" id="pledge-act" style="width:100%">Pledge with browser wallet</button>
    <p class="fine" style="text-align:center">On your phone? <a id="pledge-deeplink" href="#">Open in wallet app</a></p>
  </div>
  <p class="fine" id="backers-line">${e.backers ? `${e.backers} ${e.backers === 1 ? "backer" : "backers"} so far, ${h(e.pledgedText)} ${h(e.unit)} pledged.` : "No backers yet."}</p>
</section>`;
}

export function eventPage(ctx: ViewContext, e: EventData, link: TxLink) {
  const v = e.verdict;
  const url = `/e/${e.address}`;
  const isDeposit = e.kind === "deposit";
  let stub: string;
  if (!e.appToken) {
    stub = `<h2>Different token</h2><p>This event uses a different token than this app, so committing and refunds are not available here.</p>`;
  } else if (e.action === "commit") {
    stub = stubBlock({
      heading: isDeposit
        ? `Lock ${h(e.priceText)} ${h(e.unit)}`
        : `Commit ${h(e.priceText)} ${h(e.unit)}`,
      link,
      before: sponsoredPill(ctx) + faucetBlock(ctx),
      button: isDeposit
        ? "Lock deposit with browser wallet"
        : "Commit with browser wallet",
      buttonId: "act",
      after:
        (isDeposit
          ? `<p class="fine">At the door you scan the door screen with this wallet and the deposit comes straight back. Already in? <a href="#" id="my-ticket">Open my ticket</a>.</p>`
          : `<p class="fine">Held by the event's on-chain vault. Refundable by you if the event ends NO-GO.</p>`) +
        (e.maxParticipants
          ? `<p class="fine">Limited to ${e.maxParticipants} people.</p>`
          : ""),
    });
  } else if (e.action === "refund") {
    stub = stubBlock({
      heading: "Take it back",
      link,
      before: sponsoredPill(ctx),
      button: "Refund with browser wallet",
      buttonId: "act",
      hint: "Scan with the wallet you committed or pledged from",
      after: `<p class="fine">${
        e.cancelled
          ? "The organizer cancelled the event."
          : e.status === "NO-GO"
            ? "The event missed its goal."
            : "Nobody was checked in, so the event did not happen."
      } Tickets, deposits and backer pledges all come back; no organizer needed.</p>`,
    });
  } else {
    stub = `<h2>${e.status === "DONE" ? "That's a wrap" : "Commitments closed"}</h2>
    <p>${
      e.status === "DONE"
        ? "This event is over."
        : e.kind === "ticket"
          ? "The deadline has passed and the event is GO. See you there."
          : "The event is GO. At the door, scan the door screen with your wallet to check in and get your deposit back."
    }</p>
    ${
      isDeposit && e.status === "GO"
        ? `${sponsoredPill(ctx)}<button class="btn accent" id="my-ticket">Open my ticket</button>`
        : ""
    }`;
  }
  if (isDeposit) {
    stub += `<form class="find" id="find"><input name="pk" placeholder="Your wallet address" aria-label="Wallet address" autocomplete="off"><button class="btn sm ghost">Ticket</button></form>`;
  }
  const showBack = e.appToken && e.kind === "ticket" && e.action === "commit";

  const body = `
${tokenWarning(e)}
<main class="event">
  <section class="poster card">
    ${e.action === "refund" ? `<div class="stamp">REFUNDS OPEN</div>` : ""}
    <div class="chips"><span class="chip kind">${kindLabel(e)}</span><span class="chip s-${e.status}" id="chip">${statusLabel[e.status]}</span></div>
    <h1>${h(e.title)}</h1>
    <p class="price"><b>${h(e.priceText)} ${h(e.unit)}</b> ${isDeposit ? "deposit, back when you show up" : "ticket"} · needs ${e.minParticipants} ${e.minParticipants === 1 ? "person" : "people"}${e.hasBudget ? ` and a ${h(e.minAmountText)} ${h(e.unit)} budget` : ""}</p>
    <div class="counter"><span class="big" id="count">${e.participants}</span><span class="of" id="of"${e.participants >= e.minParticipants ? " hidden" : ""}>/ ${e.minParticipants}</span><span class="lbl" id="lbl">committed${e.participants >= e.minParticipants ? ` · min ${e.minParticipants}` : ""}${isDeposit && e.checkedIn ? ` · ${e.checkedIn} checked in` : ""}</span></div>
    ${meters(e)}
    <div class="verdict" id="verdict"><strong>${h(v.big)}</strong><span>${h(v.sub)}</span></div>
    <div id="clock">
      <div class="countdown" id="countdown" ${e.action === "commit" ? "" : "hidden"}>
        <div><b data-u="d">00</b><small>days</small></div><div><b data-u="h">00</b><small>hrs</small></div>
        <div><b data-u="m">00</b><small>min</small></div><div><b data-u="s">00</b><small>sec</small></div>
      </div>
      <p class="when">Commit deadline ${time(e.commitDeadline)} · event ends ${time(e.eventEnd)}</p>
    </div>
  </section>
  <aside class="stub card">${stub}
    <p class="fine"><a href="${url}/admin?organizer=${e.organizer}">Organizer view</a>${isDeposit ? ` · <a href="${url}/door">Door screen</a>` : ""} · <a href="${h(explorer(ctx, e.address))}" target="_blank" rel="noopener">View on explorer</a></p>
  </aside>
</main>
${showBack ? backBlock(ctx, e) : ""}
<section class="feed card" id="feed-wrap" ${e.commitments?.length ? "" : "hidden"}>
  <h3>Who's in</h3><ul id="feed"></ul>
</section>`;

  const script = `
(function(){
  var ev = ${json(e)};
  var skew = ev.now - Date.now()/1000;
  var lastGo = ev.go, lastStatus = ev.status, lastCount = ev.participants;
  var $ = function(id){ return document.getElementById(id); };
  var labels = ${json(statusLabel)};
  function feed(e){
    var list = e.commitments || [];
    $('feed-wrap').hidden = !list.length;
    $('feed').innerHTML = list.map(function(c){
      var t = c.participant.slice(0,4) + '…' + c.participant.slice(-4);
      var cls = c.checkedIn ? ' class="in"' : '';
      return e.kind === 'deposit'
        ? '<li><a' + cls + ' href="/e/' + e.address + '/ticket/' + c.participant + '">' + (c.checkedIn ? '✓ ' : '') + t + '</a></li>'
        : '<li><span>' + t + '</span></li>';
    }).join('');
  }
  function setBar(el, fill, tick){ if (!el) return; el.querySelector('i').style.width = fill + '%'; el.querySelector('.tick').style.left = tick + '%'; }
  function render(e){
    document.documentElement.dataset.status = e.status;
    var chip = $('chip'); chip.className = 'chip s-' + e.status; chip.textContent = labels[e.status];
    var count = $('count');
    if (e.participants !== lastCount) { count.textContent = e.participants; count.classList.remove('bump'); void count.offsetWidth; count.classList.add('bump'); }
    var reached = e.participants >= e.minParticipants;
    $('of').hidden = reached;
    $('lbl').textContent = 'committed' + (reached ? ' · min ' + e.minParticipants : '') + (e.kind === 'deposit' && e.checkedIn ? ' · ' + e.checkedIn + ' checked in' : '');
    var scale = Math.max(e.maxParticipants || e.minParticipants, e.minParticipants, e.participants, 1);
    setBar($('people-bar'), Math.min(100, e.participants / scale * 100), Math.min(100, e.minParticipants / scale * 100));
    if (e.hasBudget) {
      var have = BigInt(e.totalCommitted), budget = BigInt(e.minAmount), mscale = have > budget ? have : budget;
      setBar($('money-bar'), Number(have * 1000n / mscale) / 10, Number(budget * 1000n / mscale) / 10);
      $('m-people').textContent = e.participants + ' / ' + e.minParticipants;
      $('m-money').textContent = e.totalCommittedText + ' / ' + e.minAmountText + ' ' + e.unit;
      $('m-backers').textContent = (e.backers ? e.backers + (e.backers === 1 ? ' backer' : ' backers') + ' pledged ' + e.pledgedText + ' ' + e.unit + '. ' : '') + "Backers can pay for the pizza, but they can't fake the headcount.";
    }
    var bl = $('backers-line'); if (bl) bl.textContent = e.backers ? e.backers + (e.backers === 1 ? ' backer' : ' backers') + ' so far, ' + e.pledgedText + ' ' + e.unit + ' pledged.' : 'No backers yet.';
    $('verdict').innerHTML = '<strong></strong><span></span>';
    $('verdict').firstChild.textContent = e.verdict.big; $('verdict').lastChild.textContent = e.verdict.sub;
    feed(e);
    if (!lastGo && e.go && e.status === 'GO') { GN.confetti(); GN.toast("It's GO! The headcount is reached."); }
    lastGo = e.go; lastStatus = e.status; lastCount = e.participants;
  }
  function tick(){
    var left = Math.max(0, Math.floor(ev.commitDeadline - (Date.now()/1000 + skew)));
    var parts = { d: Math.floor(left/86400), h: Math.floor(left%86400/3600), m: Math.floor(left%3600/60), s: left%60 };
    document.querySelectorAll('#countdown b').forEach(function(b){ b.textContent = String(parts[b.dataset.u]).padStart(2,'0'); });
  }
  async function poll(){
    try {
      var r = await fetch('/api/event/' + ev.address, { cache: 'no-store' });
      if (r.ok) {
        var e = await r.json(); skew = e.now - Date.now()/1000;
        if (e.action !== ev.action) { location.reload(); return; }
        ev = e; render(e);
      }
    } catch (_) {}
    setTimeout(poll, 2000);
  }
  render(ev); tick(); setInterval(tick, 1000); setTimeout(poll, 2000);
  var act = $('act');
  if (act) act.addEventListener('click', function(){
    GN.run(act.dataset.tx, act, function(pk){
      if (ev.action === 'refund') GN.toast('Refunded. The money is back in your wallet.');
      else if (ev.kind === 'deposit') { GN.toast("You're in! Opening your ticket…"); setTimeout(function(){ location.href = '/e/' + ev.address + '/ticket/' + pk; }, 900); }
      else GN.toast("You're in! Committed " + ev.priceText + ' ' + ev.unit + '.');
      poll();
    });
  });
  var pf = $('pledge-form');
  if (pf) pf.addEventListener('submit', async function(x){
    x.preventDefault();
    try {
      var r = await fetch('/api/pledge-link/' + ev.address + '?amount=' + encodeURIComponent(pf.amount.value.trim()));
      var j = await r.json(); if (!r.ok) throw new Error(j.message);
      $('pledge-qr').innerHTML = j.qr; $('pledge-deeplink').href = j.solanaUrl; $('pledge-act').dataset.tx = j.txUrl;
      $('pledge-out').hidden = false;
    } catch (err) { GN.toast(err.message, 'error'); }
  });
  var pa = $('pledge-act');
  if (pa) pa.addEventListener('click', function(){
    GN.run(pa.dataset.tx, pa, function(){ GN.toast('Thanks for backing it! The pledge is in the vault.'); poll(); });
  });
  var mt = $('my-ticket');
  if (mt) mt.addEventListener('click', async function(ev2){
    ev2.preventDefault();
    try { var c = await GN.connect(); location.href = '/e/' + ev.address + '/ticket/' + c.pk; }
    catch (err) { GN.toast(err.message, 'error'); }
  });
  var f = $('find');
  if (f) f.addEventListener('submit', function(x){
    x.preventDefault(); var pk = f.pk.value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pk)) { GN.toast('That does not look like a Solana address.', 'error'); return; }
    location.href = '/e/' + ev.address + '/ticket/' + pk;
  });
})();`;
  return layout(ctx, {
    title: `${e.title} · Headcount`,
    body,
    status: e.status,
    web3: e.action !== "closed" || isDeposit,
    script,
    description: `${e.participants} / ${e.minParticipants} committed. ${TAGLINE}`,
  });
}

export function ticketPage(
  ctx: ViewContext,
  e: EventData,
  participant: string,
  c: { amount: string; checkedIn: boolean } | null,
  link: TxLink,
) {
  const isDeposit = e.kind === "deposit";
  let state: string;
  if (!c)
    state = `<div class="state">No commitment</div><p class="muted" style="text-align:center">This wallet has not committed to this event${
      e.action === "refund" ? " (or already took its refund)" : ""
    }. <a href="/e/${e.address}">Go to the event</a>.</p>`;
  else if (c.checkedIn)
    state = `<div class="state ok">Checked in ✓</div><p style="text-align:center">Deposit of <b>${h(e.priceText)} ${h(e.unit)}</b> returned. Enjoy!</p>`;
  else if (e.action === "refund")
    state = `<div class="state">Refunds open</div><p style="text-align:center">${h(e.verdict.sub)}</p>
    <p style="text-align:center"><a class="btn accent" href="/e/${e.address}">Take my ${h(e.priceText)} ${h(e.unit)} back</a></p>`;
  else if (!isDeposit)
    state = `<div class="state">You're in</div><p style="text-align:center">Your ${h(e.priceText)} ${h(e.unit)} ticket is on-chain. No check-in needed.</p>`;
  else if (!e.appToken)
    state = `<div class="state">Different token</div><p style="text-align:center">Check-in for this event is not available in this app.</p>`;
  else
    state = `<p style="text-align:center;margin:0 0 6px"><b>At the door: scan the door screen with this wallet.</b></p>
    <p class="muted" style="text-align:center;margin:0 0 16px">You check yourself in and your ${h(e.priceText)} ${h(e.unit)} deposit comes straight back.${
      e.now < e.commitDeadline
        ? ` Check-in opens at the commit deadline (${time(e.commitDeadline, "short")}).`
        : ""
    }${ctx.sponsored ? " No SOL needed." : ""}</p>
    <details><summary style="cursor:pointer;font-weight:700;text-align:center">No phone at hand? Show this to the organizer</summary>
    <div class="qr" title="Check-in: organizer scans this" style="margin-top:14px">${link.qr}</div>
    <p class="muted" style="text-align:center;margin:0">The organizer scans it with their wallet as a fallback.</p></details>`;

  const body = `
<main>
  ${tokenWarning(e)}
  <article class="ticket card">
    <div class="top">
      <div class="chips" style="display:flex;gap:8px;flex-wrap:wrap"><span class="chip kind" style="border-color:currentColor">${isDeposit ? "Admit one · deposit" : "Admit one"}</span><span class="chip s-${e.status}">${statusLabel[e.status]}</span></div>
      <h1>${h(e.title)}</h1>
      <div class="mono" style="font-size:13px">Holder ${short(participant)} · ends ${time(e.eventEnd, "short")}</div>
    </div>
    <div class="perf"></div>
    <div class="body" id="state">${state}</div>
  </article>
  <p class="fine" style="text-align:center"><a href="/e/${e.address}">← Back to the event</a></p>
</main>`;
  const script =
    c && !c.checkedIn && isDeposit && e.action !== "refund"
      ? `(function poll(){ fetch('/api/event/${e.address}/commitment/${participant}',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
      if (j.checkedIn) { GN.confetti(); document.getElementById('state').innerHTML = '<div class="state ok">Checked in ✓</div><p style="text-align:center">Deposit of <b>${h(e.priceText)} ${h(e.unit)}</b> returned. Enjoy!</p>'; }
      else setTimeout(poll, 2000); }).catch(function(){ setTimeout(poll, 3000); }); })();`
      : undefined;
  return layout(ctx, {
    title: `Ticket · ${e.title}`,
    body,
    status: e.status,
    script,
  });
}

/** The door key lives only in this browser; the organizer registers it once. */
export function doorPage(ctx: ViewContext, e: EventData) {
  if (e.kind !== "deposit" || !e.appToken)
    return layout(ctx, {
      title: `Door · ${e.title}`,
      status: e.status,
      body: `<main class="card poster" style="margin-top:12px"><div class="kicker">Door screen</div>
  <h1 style="font:400 clamp(40px,11vw,80px)/.9 var(--display);text-transform:uppercase;margin:10px 0">${h(e.title)}</h1>
  <p style="font-size:18px">${e.kind !== "deposit" ? "Door screens are for deposit events; ticket events need no check-in." : "This event uses a different token than this app."}</p><a class="btn accent" href="/e/${e.address}">Back to the event</a></main>`,
    });
  const body = `
<main class="door">
  <div class="kicker">Door screen</div>
  <h1 class="door-title">${h(e.title)}</h1>
  <div class="door-grid">
    <section class="card door-pass">
      <div id="door-register" hidden>
        <h2>Register this screen</h2>
        <p>This browser holds a door key. The organizer registers it once; after that, this screen shows a check-in pass that renews every 30 seconds.</p>
        <p class="fine" id="door-other" hidden>Another door screen is registered for this event. Registering this one replaces it.</p>
        <div class="qr" id="door-qr" style="max-width:300px"></div>
        <p class="hint">Scan with the organizer wallet</p>
        <button class="btn accent" id="door-act" style="width:100%">Register with browser wallet</button>
        <p class="fine" style="text-align:center">On the organizer's phone? <a id="door-deeplink" href="#">Open in wallet app</a></p>
      </div>
      <div id="door-live" hidden>
        <h2>Scan to check in</h2>
        <div class="qr big" id="pass-qr"></div>
        <p class="hint" id="pass-hint">Scan with the wallet you committed from. Your deposit comes straight back.</p>
        <div class="renew"><i id="renew-bar"></i></div>
        <p class="fine" style="text-align:center" id="renew-text"></p>
      </div>
      <p class="err" id="door-err" hidden></p>
    </section>
    <aside class="card door-stats">
      <div class="door-count"><b id="d-in">${e.checkedIn}</b><span>/ <span id="d-of">${e.participants}</span></span></div>
      <div class="kicker" style="margin:12px 0 14px">checked in</div>
      <p id="d-state" class="door-state"></p>
      ${ctx.sponsored ? `<p class="pill-row"><span class="pill">No SOL needed</span></p>` : ""}
      <p class="fine">Passes are signed by this screen's key and expire after 90 seconds, so a photo sent home stops working. <a href="/e/${e.address}/admin?organizer=${e.organizer}">Organizer view</a> has the manual check-in as fallback.</p>
    </aside>
  </div>
</main>`;
  const script = `
(function(){
  var ev = ${json(e)};
  var skew = ev.now - Date.now()/1000;
  var $ = function(id){ return document.getElementById(id); };
  var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58(bytes){ var n = 0n; for (var i = 0; i < bytes.length; i++) n = n * 256n + BigInt(bytes[i]); var s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n = n / 58n; } for (var j = 0; j < bytes.length && bytes[j] === 0; j++) s = '1' + s; return s; }
  function b58d(str){ var n = 0n; for (var i = 0; i < str.length; i++) n = n * 58n + BigInt(A.indexOf(str[i])); var out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n = n / 256n; } for (var j = 0; j < str.length && str[j] === '1'; j++) out.unshift(0); return Uint8Array.from(out); }
  function b64(b){ var s=''; for (var i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
  function unb64(s){ var bin = atob(s), o = new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) o[i]=bin.charCodeAt(i); return o; }
  var STORE = 'headcount-door:' + ev.address, kp = null;
  function loadKey(){
    // #key=<base58 secret> moves an existing door key to this screen (e.g. the
    // demo seed's); the fragment never reaches the server and is removed here.
    var m = /^#key=([1-9A-HJ-NP-Za-km-z]{80,90})$/.exec(location.hash);
    if (m) {
      try {
        var imported = nacl.sign.keyPair.fromSecretKey(b58d(m[1]));
        try { localStorage.setItem(STORE, b64(imported.secretKey)); } catch (_) {}
        history.replaceState(null, '', location.pathname + location.search);
        return imported;
      } catch (_) { err('That door key could not be imported.'); }
    }
    try { var s = localStorage.getItem(STORE); if (s) return nacl.sign.keyPair.fromSecretKey(unb64(s)); } catch (_) {}
    var k = nacl.sign.keyPair();
    try { localStorage.setItem(STORE, b64(k.secretKey)); } catch (_) {}
    return k;
  }
  function err(msg){ $('door-err').textContent = msg || ''; $('door-err').hidden = !msg; }
  var registered = null, passTimer = null, renewAt = 0;
  function passMessage(exp){
    var prefix = new TextEncoder().encode('headcount-pass:v1');
    var event = b58d(ev.address);
    var msg = new Uint8Array(prefix.length + 32 + 8);
    msg.set(prefix, 0); msg.set(event, prefix.length);
    new DataView(msg.buffer).setBigInt64(prefix.length + 32, BigInt(exp), true);
    return msg;
  }
  async function renewPass(){
    var exp = Math.floor(Date.now()/1000 + skew) + 90;
    var sig = nacl.sign.detached(passMessage(exp), kp.secretKey);
    try {
      var r = await fetch('/api/pass-link/' + ev.address + '?exp=' + exp + '&sig=' + b58(sig), { cache: 'no-store' });
      var j = await r.json(); if (!r.ok) throw new Error(j.message);
      $('pass-qr').innerHTML = j.qr; err('');
      renewAt = Date.now() + 30000;
    } catch (x) { err(x.message); renewAt = Date.now() + 5000; }
  }
  function renewTick(){
    var left = Math.max(0, renewAt - Date.now());
    $('renew-bar').style.width = (left / 300) + '%';
    $('renew-text').textContent = 'New pass in ' + Math.ceil(left / 1000) + ' s';
    if (left <= 0 && registered) renewPass();
  }
  async function showRegister(pub){
    $('door-live').hidden = true; $('door-register').hidden = false;
    $('door-other').hidden = !ev.doorKey;
    try {
      var r = await fetch('/api/door-link/' + ev.address + '?key=' + pub); var j = await r.json();
      if (!r.ok) throw new Error(j.message);
      $('door-qr').innerHTML = j.qr; $('door-deeplink').href = j.solanaUrl; $('door-act').dataset.tx = j.txUrl;
    } catch (x) { err(x.message); }
  }
  function stateText(e){
    var now = Date.now()/1000 + skew;
    if (e.cancelled) return 'The event was cancelled.';
    if (!e.go) return now < e.commitDeadline ? 'Not GO yet: check-in opens at the deadline if the event is GO.' : 'The event did not go ahead.';
    if (now < e.commitDeadline) return 'Check-in opens at ' + GN.fmtTime(e.commitDeadline, 'short') + '.';
    if (now > e.eventEnd) return 'The event is over; check-in is closed.';
    return 'Check-in is open until ' + GN.fmtTime(e.eventEnd, 'short') + '.';
  }
  var lastIn = ev.checkedIn;
  function render(e){
    $('d-in').textContent = e.checkedIn; $('d-of').textContent = e.participants;
    $('d-state').textContent = stateText(e);
    if (e.checkedIn > lastIn) { GN.toast('Checked in! Welcome.'); }
    lastIn = e.checkedIn;
    var pub = b58(kp.publicKey), mine = e.doorKey === pub;
    if (mine !== registered) {
      registered = mine;
      if (mine) { $('door-register').hidden = true; $('door-live').hidden = false; renewPass(); }
      else showRegister(pub);
    }
  }
  async function poll(){
    try { var r = await fetch('/api/event/' + ev.address, { cache: 'no-store' }); if (r.ok) { var e = await r.json(); skew = e.now - Date.now()/1000; ev = e; render(e); } } catch (_) {}
    setTimeout(poll, 2000);
  }
  function start(){
    if (!window.nacl) { err('Could not load the signing library (tweetnacl).'); return; }
    kp = loadKey(); render(ev); setInterval(renewTick, 250); setTimeout(poll, 2000);
    $('door-act').addEventListener('click', function(){
      var b = this; GN.run(b.dataset.tx, b, function(){ GN.toast('Door screen registered.'); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`;
  return layout(ctx, {
    title: `Door · ${e.title}`,
    body,
    status: e.status,
    web3: true,
    scripts: ["/vendor/nacl-fast.min.js"],
    script,
  });
}

export function adminPage(
  ctx: ViewContext,
  e: EventData,
  organizer: string,
  link: TxLink,
  cancel: TxLink | null,
  close: TxLink | null = null,
) {
  const isTicket = e.kind === "ticket";
  const go = e.go;
  const payoutNote = e.cancelled
    ? "The event is cancelled. The money goes back to the participants and backers."
    : !go
      ? "Available once the event is GO."
      : isTicket && e.now < e.commitDeadline
        ? `Payout available after the deadline (${time(e.commitDeadline, "short")}). Until then you can still cancel.`
        : !isTicket && e.now <= e.eventEnd
          ? `Available after the event ends (${time(e.eventEnd, "short")}): whatever is left in the vault are no-show deposits.`
          : !isTicket && e.checkedIn === 0
            ? "Nobody was checked in, so participants take their deposits back instead."
            : BigInt(e.vault ?? "0") === 0n
              ? "The vault is empty. Nothing to pay out right now."
              : isTicket
                ? "Tickets and pledges are yours. You can withdraw again if more people commit."
                : "The event is over. The remaining deposits belong to you.";
  // Mirrors withdraw / sweep in the program.
  const payoutAvailable =
    e.appToken &&
    !e.cancelled &&
    go &&
    BigInt(e.vault ?? "0") > 0n &&
    (isTicket
      ? e.now >= e.commitDeadline
      : e.now > e.eventEnd && e.checkedIn > 0);
  const payoutHeading = isTicket ? "Withdraw sales" : "Sweep no-shows";
  const cancelBlock = cancel
    ? `<details class="card cancel" style="margin-top:14px;padding:16px 18px">
      <summary style="cursor:pointer;font-weight:700">Cancel the event</summary>
      <p class="fine">Calls it off for good. Every participant and backer can refund themselves right away. Only possible before the commit deadline (${time(e.commitDeadline, "short")}), while nothing was paid out and nobody was checked in.</p>
      <div class="qr" style="max-width:220px">${cancel.qr}</div>
      <p class="hint" style="text-align:center">Scan with the organizer wallet</p>
      <button class="btn ghost" id="cancel" data-tx="${h(cancel.txPath)}" style="width:100%">Cancel with browser wallet</button>
    </details>`
    : "";

  const closeBlock = close
    ? `<details class="card cancel" style="margin-top:14px;padding:16px 18px" open>
      <summary style="cursor:pointer;font-weight:700">Close the event</summary>
      <p class="fine">Everyone has their money back. Closing removes the event and its vault from the chain and returns the account rent to you. The event page goes away.</p>
      <div class="qr" style="max-width:220px">${close.qr}</div>
      <p class="hint" style="text-align:center">Scan with the organizer wallet</p>
      <button class="btn ghost" id="close" data-tx="${h(close.txPath)}" style="width:100%">Close with browser wallet</button>
    </details>`
    : "";

  const warn = !organizer
    ? `<div class="warn">Open this page with <span class="mono">?organizer=&lt;your wallet&gt;</span>. Only the organizer wallet ${short(e.organizer)} can sign these actions.</div>`
    : organizer !== e.organizer
      ? `<div class="warn">This event belongs to ${short(e.organizer)}, not ${h(short(organizer))}. Transactions from another wallet are rejected.</div>`
      : "";

  const door = isTicket
    ? ""
    : `<section class="card feed" style="margin:0 0 18px">
      <h3>Door screen</h3>
      <p class="fine" style="margin:0 0 12px">${
        e.doorKey
          ? `A door screen is registered (key <span class="mono">${short(e.doorKey)}</span>). Attendees scan its pass with their wallet and check themselves in.`
          : "No door screen yet. Open it on the laptop or tablet at the entrance and register it once with this wallet."
      }</p>
      <a class="btn" href="/e/${e.address}/door">Open door screen</a>
    </section>`;

  const body = `
<main>
  <div class="kicker">Organizer view</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><span class="chip kind">${kindLabel(e)}</span><span class="chip s-${e.status}" id="chip">${statusLabel[e.status]}</span></div>
  <h1 style="font:400 clamp(40px,11vw,80px)/.9 var(--display);text-transform:uppercase;overflow-wrap:anywhere">${h(e.title)}</h1>
  ${warn}
  ${tokenWarning(e)}
  <div class="stats">
    <div class="stat card"><b id="s-part">${e.participants} / ${e.minParticipants}</b><small>committed</small></div>
    ${
      isTicket
        ? `<div class="stat card"><b id="s-budget">${h(e.totalCommittedText)}${e.hasBudget ? ` / ${h(e.minAmountText)}` : ""}</b><small>${h(e.unit)} ${e.hasBudget ? "of budget" : "committed"}</small></div>`
        : `<div class="stat card"><b id="s-in">${e.checkedIn}</b><small>checked in</small></div>`
    }
    <div class="stat card"><b id="s-vault">${h(e.vaultText ?? "0")}</b><small>${h(e.unit)} in vault</small></div>
    <div class="stat card"><b id="s-out">${h(e.withdrawnText)}</b><small>${h(e.unit)} paid out</small></div>
  </div>
  ${door}
  <div class="event">
    <section class="card feed" style="margin:0">
      <h3>Commitments</h3>
      ${
        isTicket
          ? ""
          : `<p class="fine" style="margin:0 0 12px">Attendees check themselves in at the door screen. Fallback for someone without a phone: press <b>Check in</b> here with the browser wallet, or scan their ticket QR with this wallet.${
              e.now < e.commitDeadline
                ? ` <b>Check-in opens at the commit deadline (${time(e.commitDeadline, "short")}).</b>`
                : ""
            }</p>`
      }
      <div style="overflow-x:auto"><table class="list"><thead><tr><th>Participant</th><th class="amt">Amount</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      <p class="fine" id="none" hidden>No commitments yet.</p>
      ${
        isTicket
          ? `<h3 style="margin-top:22px">Backers</h3>
      <p class="fine" style="margin:0 0 8px">Pledges count toward the budget, never toward the headcount.</p>
      <div style="overflow-x:auto"><table class="list"><thead><tr><th>Backer</th><th>Pledge</th></tr></thead><tbody id="brows"></tbody></table></div>
      <p class="fine" id="bnone" hidden>No backers yet.</p>`
          : ""
      }
    </section>
    <aside class="stub card">
      ${
        !e.appToken
          ? `<h2>Different token</h2><p>Payouts for this event are not available in this app.</p>`
          : !payoutAvailable
            ? `<h2>${payoutHeading}</h2><p class="fine" id="payout-note" style="font-size:15px">${payoutNote}</p>`
            : stubBlock({
                heading: payoutHeading,
                link,
                button: isTicket
                  ? "Withdraw with browser wallet"
                  : "Sweep with browser wallet",
                buttonId: "act",
                hint: "Scan with the organizer wallet",
                after: `<p class="fine" id="payout-note">${payoutNote} ${isTicket ? "Headcount keeps a 2 % fee." : "Headcount keeps 5 % of the no-show deposits."}</p>`,
              })
      }
      <p class="fine"><a href="/e/${e.address}">Public event page</a></p>
      ${cancelBlock}
      ${closeBlock}
    </aside>
  </div>
</main>`;

  const script = `
(function(){
  var ev = ${json(e)};
  var labels = ${json(statusLabel)};
  var $ = function(id){ return document.getElementById(id); };
  function render(e){
    document.documentElement.dataset.status = e.status;
    $('chip').className = 'chip s-' + e.status; $('chip').textContent = labels[e.status];
    $('s-part').textContent = e.participants + ' / ' + e.minParticipants;
    if ($('s-in')) $('s-in').textContent = e.checkedIn;
    if ($('s-budget')) $('s-budget').textContent = e.totalCommittedText + (e.hasBudget ? ' / ' + e.minAmountText : '');
    $('s-vault').textContent = e.vaultText; $('s-out').textContent = e.withdrawnText;
    var list = (e.commitments || []).slice().sort(function(a,b){ return (a.checkedIn - b.checkedIn) || a.participant.localeCompare(b.participant); });
    $('none').hidden = list.length > 0;
    $('rows').innerHTML = list.map(function(c){
      var t = c.participant.slice(0,4) + '…' + c.participant.slice(-4);
      var st = e.kind === 'ticket' ? '<span class="chip">paid</span>' : c.checkedIn ? '<span class="chip s-GO">checked in</span>' : '<span class="chip">waiting</span>';
      var act = e.appToken && e.checkInOpen && !c.checkedIn
        ? '<button class="btn sm" data-ci="' + c.participant + '">Check in</button>'
        : '';
      return '<tr><td class="mono"><a href="/e/' + e.address + '/ticket/' + c.participant + '">' + t + '</a></td><td class="mono amt">' + c.amountText + '</td><td>' + st + '</td><td>' + act + '</td></tr>';
    }).join('');
    if ($('brows')) {
      var pl = e.pledges || [];
      $('bnone').hidden = pl.length > 0;
      $('brows').innerHTML = pl.map(function(p){ return '<tr><td class="mono">' + p.backer.slice(0,4) + '…' + p.backer.slice(-4) + '</td><td class="mono">' + p.amountText + ' ' + e.unit + '</td></tr>'; }).join('');
    }
  }
  document.addEventListener('click', function(x){
    var b = x.target.closest('[data-ci]'); if (!b) return;
    GN.run('/api/tx/checkin/' + ev.address + '/' + b.dataset.ci, b, function(){ GN.toast('Checked in. Deposit returned.'); poll(true); });
  });
  var act = $('act');
  if (act) act.addEventListener('click', function(){ GN.run(act.dataset.tx, act, function(_pk, _sig, msg){ GN.toast('Paid out. ' + (msg || '')); poll(true); }); });
  var cancel = $('cancel');
  if (cancel) cancel.addEventListener('click', function(){
    if (!confirm('Cancel this event? Everyone will be able to take their money back. This cannot be undone.')) return;
    GN.run(cancel.dataset.tx, cancel, function(){ GN.toast('Event cancelled. Refunds are open.'); setTimeout(function(){ location.reload(); }, 1200); });
  });
  var close = $('close');
  if (close) close.addEventListener('click', function(){
    if (!confirm('Close this event for good? Its page goes away.')) return;
    GN.run(close.dataset.tx, close, function(){ GN.toast('Event closed. Rent returned.'); setTimeout(function(){ location.href = '/'; }, 1200); });
  });
  var first = { status: ev.status, action: ev.action, canCancel: ev.canCancel, doorKey: ev.doorKey };
  async function poll(once){
    try {
      var r = await fetch('/api/event/' + ev.address, { cache: 'no-store' });
      if (r.ok) {
        ev = await r.json();
        // Payout / cancel / door availability is rendered on the server: refresh when it changes.
        if (ev.status !== first.status || ev.action !== first.action || ev.canCancel !== first.canCancel || ev.doorKey !== first.doorKey) { location.reload(); return; }
        render(ev);
      }
    } catch (_) {}
    if (!once) setTimeout(poll, 3000);
  }
  render(ev); setTimeout(poll, 3000);
})();`;
  return layout(ctx, {
    title: `Organizer · ${e.title}`,
    body,
    status: e.status,
    web3: true,
    script,
  });
}

export function newPage(ctx: ViewContext, enabled: boolean) {
  const body = `
<main class="event">
  <section>
    <div class="kicker">New event</div>
    <h1 style="font:400 clamp(48px,13vw,96px)/.88 var(--display);text-transform:uppercase;margin:10px 0 18px">Set the bar.<br>See who shows.</h1>
    ${enabled ? "" : `<div class="err">The server has no MINT configured, so events cannot be created.</div>`}
    <form class="new card" id="form">
      <label class="f">Title <small>What's happening? Max 64 characters.</small>
        <input name="title" required maxlength="64" placeholder="Pizza &amp; Pitches, Berlin" autocomplete="off"></label>
      <fieldset class="kinds"><legend>Kind</legend>
        <label><input type="radio" name="kind" value="ticket" checked><b>Ticket</b><span>People pay to attend. You get paid once it's GO.</span></label>
        <label><input type="radio" name="kind" value="deposit"><b>Deposit</b><span>Free event. A small deposit returns at check-in; no-shows pay for the pizza.</span></label>
      </fieldset>
      <div class="two">
        <label class="f">Price (${h(ctx.symbol)})<input name="price" required inputmode="decimal" pattern="\\d+(\\.\\d{1,6})?" value="5"></label>
        <label class="f">Minimum<input name="min" required type="number" min="1" value="12"></label>
      </div>
      <label class="f">Maximum <small>Optional. Leave empty for no cap.</small><input name="max" type="number" min="1" placeholder="no cap"></label>
      <label class="f" id="budget-wrap">Budget goal (${h(ctx.symbol)}) <small>Optional, ticket events. GO also needs tickets plus backer pledges to reach this. Backers can pay for the pizza, but they can't fake the headcount.</small><input name="budget" inputmode="decimal" pattern="\\d+(\\.\\d{1,6})?" placeholder="no budget"></label>
      <label class="f">Commit deadline <small>GO or NO-GO is decided at this moment.</small><input name="deadline" type="datetime-local" required></label>
      <div class="presets" data-for="deadline"><button type="button" data-min="3">+3 min</button><button type="button" data-min="60">+1 h</button><button type="button" data-min="1440">+1 day</button><button type="button" data-min="10080">+1 week</button></div>
      <label class="f">Event end <small>Deposit events: check-in closes, no-shows can be swept.</small><input name="end" type="datetime-local" required></label>
      <div class="presets" data-for="end"><button type="button" data-min="5">deadline +5 min</button><button type="button" data-min="180">deadline +3 h</button><button type="button" data-min="1440">deadline +1 day</button></div>
      <div id="form-err" class="err" hidden></div>
      <button class="btn accent" ${enabled ? "" : "disabled"}>Create sign link</button>
    </form>
  </section>
  <aside class="stub card" id="result" hidden>
    <h2>Sign to create</h2>
    <div class="qr" id="qr"></div>
    <p class="hint">Scan with the organizer wallet (Phantom)</p>
    <div class="or">OR ON THIS DEVICE</div>
    <button class="btn accent" id="act">Create with browser wallet</button>
    <p class="fine" style="text-align:center">On your phone? <a id="deeplink" href="#">Open in wallet app</a></p>
    <p class="fine" id="waiting">Waiting for the transaction…</p>
    <div id="done" hidden>
      <p><b>Your event is live.</b></p>
      <p style="display:grid;gap:8px"><a class="btn accent" id="open-event">Open event page</a><a class="btn ghost" id="open-admin">Organizer view</a></p>
    </div>
  </aside>
</main>`;

  const script = `
(function(){
  var form = document.getElementById('form'), err = document.getElementById('form-err');
  var budgetWrap = document.getElementById('budget-wrap');
  function syncKind(){ budgetWrap.hidden = form.kind.value !== 'ticket'; }
  form.addEventListener('change', syncKind); syncKind();
  function toLocal(d){ var p = function(n){ return String(n).padStart(2,'0'); }; return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  var dl = new Date(Date.now() + 86400e3); dl.setMinutes(0, 0, 0);
  form.deadline.value = toLocal(dl); form.end.value = toLocal(new Date(dl.getTime() + 3 * 3600e3));
  document.querySelectorAll('.presets').forEach(function(box){
    box.addEventListener('click', function(x){
      var b = x.target.closest('button'); if (!b) return;
      var mins = +b.dataset.min;
      if (box.dataset.for === 'deadline') {
        var d = new Date(Date.now() + mins * 60e3); if (mins >= 60) d.setSeconds(0, 0);
        form.deadline.value = toLocal(d);
        if (new Date(form.end.value) < d) form.end.value = toLocal(new Date(d.getTime() + 5 * 60e3));
      } else form.end.value = toLocal(new Date(new Date(form.deadline.value).getTime() + mins * 60e3));
    });
  });
  var pollId = 0, knownOrg = '';
  // /api/find is organizer-scoped: event ids are only unique per organizer.
  form.addEventListener('submit', async function(x){
    x.preventDefault(); err.hidden = true;
    var dl = Math.floor(new Date(form.deadline.value).getTime() / 1000), end = Math.floor(new Date(form.end.value).getTime() / 1000);
    var qs = new URLSearchParams({ title: form.title.value.trim(), kind: form.kind.value, price: form.price.value.trim(), min: form.min.value, max: form.max.value || '0', deadline: String(dl), end: String(end) });
    if (form.kind.value === 'ticket' && form.budget.value.trim()) qs.set('budget', form.budget.value.trim());
    try {
      var r = await fetch('/api/create-link?' + qs); var j = await r.json();
      if (!r.ok) throw new Error(j.message);
      document.getElementById('qr').innerHTML = j.qr;
      document.getElementById('deeplink').href = j.solanaUrl;
      var res = document.getElementById('result'); res.hidden = false;
      document.getElementById('done').hidden = true; document.getElementById('waiting').hidden = false;
      var act = document.getElementById('act'); act.hidden = false; act.dataset.tx = j.txUrl;
      if (innerWidth < 980) res.scrollIntoView({ behavior: 'smooth' });
      var my = ++pollId;
      (function poll(){
        if (my !== pollId) return;
        fetch('/api/find/' + j.eventId + (knownOrg ? '?organizer=' + knownOrg : '')).then(function(r){ return r.json(); }).then(function(f){
          if (!f.found) return setTimeout(poll, 2000);
          document.getElementById('waiting').hidden = true; act.hidden = true;
          document.getElementById('done').hidden = false;
          document.getElementById('open-event').href = '/e/' + f.address;
          document.getElementById('open-admin').href = '/e/' + f.address + '/admin?organizer=' + f.organizer;
          GN.confetti();
        }).catch(function(){ setTimeout(poll, 3000); });
      })();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
  document.getElementById('act').addEventListener('click', function(){
    var b = this; GN.run(b.dataset.tx, b, function(pk){ knownOrg = pk; GN.toast('Event created!'); });
  });
})();`;
  return layout(ctx, {
    title: "New event · Headcount",
    body,
    web3: true,
    script,
  });
}

export function errorPage(ctx: ViewContext, status: number, message: string) {
  return layout(ctx, {
    title: `${status} · Headcount`,
    status: "NO-GO",
    body: `<main class="card poster" style="margin-top:12px"><div class="kicker">Error ${status}</div>
  <h1 style="font:400 clamp(56px,16vw,120px)/.9 var(--display);text-transform:uppercase;margin:10px 0">No-go.</h1>
  <p style="font-size:18px">${h(message)}</p><a class="btn accent" href="/">Back to the board</a></main>`,
  });
}

/** Fallback favicon when brand/ is missing. */
export const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#12110F"/><rect x="4" y="6" width="4" height="20" fill="#F2EDE1"/><rect x="10" y="6" width="4" height="20" fill="#F2EDE1"/><rect x="16" y="6" width="4" height="20" fill="#F2EDE1"/><rect x="22" y="6" width="4" height="20" fill="#F2EDE1"/><g transform="rotate(-30 15 16.5)"><rect x="0.5" y="13.5" width="31" height="6.5" rx="1" fill="#B9F43C" stroke="#12110F" stroke-width="2"/></g></svg>`;
