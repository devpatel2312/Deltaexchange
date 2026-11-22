#!/usr/bin/env bash
# Run from this repo on your PC:  bash deploy/deploy.sh ubuntu@SERVER_IP
# Copies the app (and .env) to the server and (re)starts it. Data in ~/delta-desk/data is kept.
set -euo pipefail
HOST="$1"
KEY="${SSH_KEY:-$HOME/.ssh/delta_vps}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
cd "$(dirname "$0")/.."

$SSH "$HOST" 'mkdir -p ~/delta-desk/data'
tar czf - --exclude=.git --exclude=.sf --exclude=__pycache__ --exclude='*.sqlite3*' \
    --exclude='upstox_token.json' --exclude='upstox-NSE-*' --exclude='upstox_fail_*' --exclude=data . \
  | $SSH "$HOST" 'tar xzf - -C ~/delta-desk'
$SSH "$HOST" 'bash ~/delta-desk/deploy/server-setup.sh && cd ~/delta-desk && sudo docker compose up -d --build && sudo docker compose ps'
