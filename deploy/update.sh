#!/bin/sh
# Redeploys when origin/main has new commits. Meant for cron, e.g. every minute:
#   * * * * * root /path/to/status-check/deploy/update.sh >> /var/log/status-check-deploy.log 2>&1
# Set COMPOSE_PROFILES=db in .env if you use the bundled Postgres.
set -eu
cd "$(dirname "$0")/.."

# One deploy at a time: a slow build must not overlap the next cron run.
exec 9>/tmp/status-check-update.lock
flock -n 9 || exit 0

git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

echo "$(date -u +%FT%TZ) deploying $(git rev-parse --short origin/main)"
git merge -q --ff-only origin/main
docker compose up -d --build
docker image prune -f --filter label=com.docker.compose.project=status-check >/dev/null
echo "$(date -u +%FT%TZ) done"
