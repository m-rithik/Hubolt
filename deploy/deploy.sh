#!/usr/bin/env bash
# Deploy Hubolt on the server: pull latest main, build, migrate, restart, verify.
# Run by Bitbucket Pipelines over SSH, or manually on the server:
#   cd /opt/hubolt && bash deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/hubolt
SERVICE=hubolt-server
BRANCH=main
HEALTH_URL="http://127.0.0.1:3000/health"

cd "$APP_DIR"

# Record the currently deployed commit so rollback.sh can return to it.
git rev-parse HEAD > .last_deploy

echo "Fetching origin/$BRANCH ..."
git fetch --all --prune
git reset --hard "origin/$BRANCH"

echo "Installing dependencies ..."
npm ci

echo "Building ..."
npm run build

echo "Applying database migrations ..."
# Load DATABASE_URL (and the rest) so the prisma CLI can connect.
set -a
. "$APP_DIR/.env"
set +a
npx prisma migrate deploy

echo "Restarting $SERVICE ..."
sudo systemctl restart "$SERVICE"

echo "Health check ..."
for _ in $(seq 1 10); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Deploy OK: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

echo "Health check FAILED after restart. Rolling back ..." >&2
bash "$APP_DIR/deploy/rollback.sh"
exit 1
