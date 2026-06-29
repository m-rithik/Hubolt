#!/usr/bin/env bash
# Roll back Hubolt to the previously deployed commit recorded in .last_deploy.
# Run manually on the server, or invoked automatically by deploy.sh on a failed
# health check:
#   cd /opt/hubolt && bash deploy/rollback.sh
#
# NOTE on the database: this reverts CODE only. Prisma migrations are not undone
# (Prisma has no automatic down-migrations). Additive migrations are normally
# backward compatible with older code. A destructive migration (dropped/renamed
# column) must be reversed by hand from a backup before the old code will work.
set -euo pipefail

APP_DIR=/opt/hubolt
SERVICE=hubolt-server
WORKER_SERVICE=hubolt-worker

cd "$APP_DIR"

if [ ! -f .last_deploy ]; then
  echo "No .last_deploy file found; cannot determine the previous commit." >&2
  echo "Pick one manually:  git log --oneline -n 20  then  git reset --hard <sha>" >&2
  exit 1
fi

TARGET="$(cat .last_deploy)"
echo "Rolling back to $TARGET ..."
git reset --hard "$TARGET"

npm ci
npm run build

set -a
. "$APP_DIR/.env"
set +a
npx prisma migrate deploy

sudo systemctl restart "$SERVICE"

if systemctl list-unit-files "$WORKER_SERVICE.service" >/dev/null 2>&1 && \
   systemctl is-enabled "$WORKER_SERVICE" >/dev/null 2>&1; then
  sudo systemctl restart "$WORKER_SERVICE"
fi

echo "Rollback complete: $(git rev-parse --short HEAD)"
