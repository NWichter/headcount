#!/usr/bin/env bash
# Deploys or upgrades the program on devnet (run in WSL/Linux).
# Needs ~4 SOL for a first deploy, ~3.2 SOL for an upgrade (buffer is returned).
set -euo pipefail
cd "$(dirname "$0")/../anchor"
SOLANA="${SOLANA:-$HOME/.local/share/solana/install/active_release/bin/solana}"
URL=https://api.devnet.solana.com
SO=target/deploy/headcount.so
KEY=target/deploy/headcount-keypair.json
PROGRAM_ID=$("$SOLANA" address -k "$KEY")
SIZE=$(stat -c %s "$SO")
# 20 % headroom so later upgrades need no extend.
WANT=$(( SIZE * 12 / 10 ))

if "$SOLANA" program show "$PROGRAM_ID" -u "$URL" >/dev/null 2>&1; then
  HAVE=$("$SOLANA" program show "$PROGRAM_ID" -u "$URL" | awk '/Data Length/ {print $3}')
  if [ "$HAVE" -lt "$SIZE" ]; then
    echo "extending program data: $HAVE -> $WANT bytes"
    "$SOLANA" program extend "$PROGRAM_ID" $(( WANT - HAVE )) -u "$URL"
  fi
  "$SOLANA" program deploy "$SO" --program-id "$KEY" -u "$URL" --with-compute-unit-price 1
else
  "$SOLANA" program deploy "$SO" --program-id "$KEY" --max-len "$WANT" -u "$URL" --with-compute-unit-price 1
fi
"$SOLANA" program show "$PROGRAM_ID" -u "$URL" | grep -E "Program Id|Data Length|Last Deployed"
"$SOLANA" balance -u "$URL"
