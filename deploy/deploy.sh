#!/usr/bin/env bash
# ============================================================================
#  deploy.sh — Runs ON the VPS, triggered by the CD job over SSH.
#  The deploy key is pinned to this script in authorized_keys (forced command),
#  so that key can't open a shell or run anything else.
#  Pulls main, rebuilds the stack, waits for the demo to answer /health.
# ============================================================================
set -euo pipefail

# Wrapped in a function: bash reads the whole body before running it, so the
# `git reset` below can safely rewrite this very file mid-deploy.
main() {
  cd "$(dirname "$(readlink -f "$0")")/.."
  local project="${COMPOSE_PROJECT_NAME:-webhook}"
  local compose=(docker compose -p "$project" -f docker-compose.prod.yml)

  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  echo "deploying $(git log -1 --format='%h %s')"

  "${compose[@]}" up -d --build --remove-orphans

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${DEMO_PORT:-3100}/health" >/dev/null; then
      docker image prune -f >/dev/null
      echo "healthy"
      return 0
    fi
    sleep 2
  done

  echo "health check failed" >&2
  "${compose[@]}" ps >&2
  "${compose[@]}" logs --tail 50 demo api worker >&2
  return 1
}

main "$@"
