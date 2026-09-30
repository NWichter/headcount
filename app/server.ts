import "dotenv/config";
import { createApp } from "./app.js";
import { parseSecretKey } from "./chain.js";

const port = Number(process.env.PORT ?? 4040);
const cluster = process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "localnet";
const rpcUrl =
  process.env.SOLANA_RPC_URL ??
  (cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899");
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

// Optional app wallet that pays fees and rent so phones need no SOL.
let sponsor: import("@solana/web3.js").Keypair | undefined;
if (process.env.SPONSOR_SECRET_KEY) {
  try {
    sponsor = parseSecretKey(process.env.SPONSOR_SECRET_KEY);
  } catch {
    console.error(
      "SPONSOR_SECRET_KEY is not a valid base58 secret key (or JSON byte array).",
    );
    process.exit(1);
  }
}

// Demo faucet mint authority; cluster is never mainnet here.
let faucetAuthority: import("@solana/web3.js").Keypair | undefined;
if (process.env.TEST_MINT_AUTHORITY) {
  try {
    faucetAuthority = parseSecretKey(process.env.TEST_MINT_AUTHORITY);
  } catch {
    console.error("TEST_MINT_AUTHORITY is not a valid secret key.");
    process.exit(1);
  }
}

const { app, chain } = createApp({
  rpcUrl,
  cluster,
  publicUrl,
  mint: process.env.MINT,
  symbol: process.env.MINT_SYMBOL,
  sponsor,
  faucetAuthority,
});

if (sponsor)
  setInterval(
    () =>
      chain
        .crankRefunds()
        .then((n) => n && console.log(`refunded ${n} commitments and pledges`))
        .catch((e) => console.warn(`refund crank failed: ${e.message}`)),
    10 * 60_000,
  ).unref();

if (sponsor)
  setInterval(
    () =>
      chain
        .reclaimSponsoredRent()
        .then(
          (n) => n && console.log(`reclaimed rent from ${n} settled accounts`),
        )
        .catch((e) => console.warn(`rent reclaim failed: ${e.message}`)),
    30 * 60_000,
  ).unref();

app.listen(port, () => {
  console.log(
    `Headcount on ${publicUrl} (port ${port}) · ${cluster} · RPC ${rpcUrl}`,
  );
  if (!process.env.MINT)
    console.warn("MINT is not set: creating events is disabled.");
  if (sponsor)
    console.log(
      `Sponsored fees: ${sponsor.publicKey.toBase58()} pays fees and rent.`,
    );
  if (!/^https:\/\//.test(publicUrl))
    console.warn(
      "PUBLIC_URL is not https: phone wallets require https for Solana Pay links.",
    );
  chain
    .isDeployed()
    .then(
      (ok) =>
        !ok &&
        console.warn("The headcount program is not deployed on this cluster."),
    )
    .catch((e) => console.warn(`RPC not reachable: ${e.message}`));
});
