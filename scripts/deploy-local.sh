#!/usr/bin/env bash
# Deploys the built program to a local validator (run inside WSL/Linux).
set -euo pipefail
cd "$(dirname "$0")/../anchor"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
URL="${SOLANA_RPC_URL:-http://127.0.0.1:8899}"
solana program deploy target/deploy/headcount.so --program-id target/deploy/headcount-keypair.json -u "$URL"
