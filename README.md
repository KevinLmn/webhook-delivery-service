# Webhook Delivery Service

[![CI](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml/badge.svg)](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml)

Node/TypeScript service that ingests events through an HTTP API and delivers them to third-party client endpoints, with exponential retry, circuit breaker, idempotency keys and manual replay. API model aligned with [Standard Webhooks](https://www.standardwebhooks.com).

> Showcase project. Not a production service used by real customers.

**Live demo**: a public page where anyone can trigger an outage scenario and watch retries, the circuit breaker and dead letters play out in real time (see [Live demo page](#live-demo-page)).

## V1 features

- Multi-tenant Fastify API with Bearer auth (argon2id).
- Mandatory idempotency keys (Redis, 24h TTL).
- BullMQ worker with exponential retry (1s → 10s → 1min → 10min → 1h → 6h, 7 attempts max).
- Shared circuit breaker (atomic state machine in Lua).
- Standard Webhooks HMAC signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
- Secrets encrypted at rest (AES-256-GCM, separate master key).
- Single-event replay.
- Integration tests with Testcontainers (Postgres + Redis).

### Standard Webhooks interoperability note

The implementation follows the Standard Webhooks **shape** (signed string `id.timestamp.body`, `webhook-*` headers, `v1,<base64>` scheme), but uses the secret **as raw UTF-8** as the HMAC key. The Svix variant base64-decodes the secret after stripping the `whsec_` prefix before HMAC. Bit-for-bit Svix consumers will therefore not validate our signatures without adapting their HMAC key. The header format and the signed string remain compatible.

## Out of scope V1

See [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md) section 10. In particular: no public signup, no endpoint secret rotation, no batch replay, no production-grade observability, no client SDKs, no Rust port (separate spec), no dashboard (separate spec), no AWS (separate spec).

## Run locally

Prerequisites: Node 22 LTS, pnpm 9, Docker Compose.

```bash
nvm use
pnpm install

# local infra (Postgres + Redis)
docker compose up -d

# migrations
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine pnpm db:push

# create a client (note the API key, shown only once)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine \
  pnpm cli:create-client --name local

# .env (see .env.example)
cp .env.example .env
# set MASTER_ENCRYPTION_KEY = $(openssl rand -base64 32)

# run API + Worker in parallel
pnpm dev
```

### End-to-end smoke test

Once `pnpm dev` is running, in another terminal:

```bash
API_KEY=cl_secret_...  # from cli:create-client

# create an endpoint
curl -s -X POST http://localhost:3000/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/post"}'
# → note ep_xxx

# push an event
curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: smoke-1" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_id":"ep_xxx","event_type":"smoke.test","payload":{"hello":"world"}}'

# check the status after ~5s
curl -s http://localhost:3000/events/evt_xxx -H "Authorization: Bearer $API_KEY"
# → status: "delivered"
```

## Tests

```bash
pnpm test:unit           # unit tests (packages), < 5s
pnpm test:integration    # 16 integration tests (Testcontainers Postgres + Redis), ~3 min
```

## Chaos demo

The `pnpm demo:chaos` script orchestrates an end-to-end demo that:

1. spawns a local fake endpoint scripted in 4 phases (200 OK → 500 → 50/50 → 200 OK);
2. boots a Postgres + Redis + API + Worker stack via `docker-compose.demo.yml`;
3. pushes 100 events spread over 90 s (so traffic keeps flowing through the outage), samples the system state at 1 Hz for ~140 s;
4. generates an annotated PNG in `docs/chaos-runs/`.

```bash
pnpm demo:chaos
```

The run takes ~3 min. The PNG illustrates the circuit breaker mechanics: opening during the outage phase, `half_open` transition after the cooldown, back to `closed` on recovery.

### Latest run

![Latest chaos run](docs/chaos-runs/2026-10-13-05-48.png)

What it shows: the endpoint starts returning `500` at t=10 s; after 5 consecutive failures the breaker opens (~t=13 s) and the worker stops hammering it, so events queue up as `pending` instead of burning retries. After the 30 s cooldown the breaker goes `half_open`, the probe succeeds, it closes again and the backlog drains. Through the 50/50 phase, retries absorb the failures. End state: 100/100 delivered, 0 dead.

## Architecture

```mermaid
flowchart LR
  Client[Client] -->|POST /events| API[API · Fastify]
  API -->|idempotency check| R[(Redis)]
  API -->|insert event| DB[(Postgres)]
  API -->|enqueue| Q[BullMQ queue]
  Q --> W[Worker · BullMQ]
  W -->|check / update breaker| R
  W -->|signed HTTP POST| EP[Client endpoint]
  W -->|delivery_attempt + status| DB
  W -->|retry with backoff| Q
  W -->|attempts exhausted| DLQ[Dead letter]
```

- **API** (Fastify): ingestion (`POST /events`, `Idempotency-Key` required), endpoint CRUD, replay, reads. Answers `202` right away; delivery is asynchronous.
- **Worker** (BullMQ, separate process, same image): checks the endpoint's circuit breaker, signs the payload (HMAC, Standard Webhooks headers), delivers it, logs every attempt.
- **Postgres**: durable source of truth (`clients`, `endpoints`, `events`, `delivery_attempts`).
- **Redis**: shared volatile state: breaker state, idempotency cache, BullMQ jobs.

**Delivery rules**

- Retry schedule: immediate → 1 s → 10 s → 1 min → 10 min → 1 h → 6 h (7 attempts, ±20% jitter), `Retry-After` honored.
- `4xx` (except `429`) is permanent and goes straight to `dead`; `5xx`, `429`, timeouts and network errors are retried.
- Circuit breaker per endpoint: 5 consecutive failures → `open` for 30 s (doubling on each relapse, capped at 30 min) → `half_open` probe → `closed`. State transitions run in an atomic Lua script so multiple workers share one breaker.

Full design: [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md).

## Live demo page

`apps/demo` serves a public page with a single button: **Run outage scenario**.

- A run creates a fresh endpoint, then pushes 100 `order.created` events through the real API over 90 s.
- The endpoint is a fake customer server on an internal port. It verifies every HMAC signature, then follows the same 4 phases as the chaos demo (200 → 500 → 50/50 → 200). 4 events carry a payload it rejects with `422`, to show the dead-letter path.
- The service samples Postgres and Redis every second and streams the state to every open page over Server-Sent Events, so all visitors watch the same run.
- Abuse limits: one run at a time, one run per IP every 3 minutes, and visitors can't supply a URL. The API, worker, Postgres and Redis are never exposed.
- The last finished run is kept in Redis, so the page is never empty after a restart.

The page is plain HTML/CSS/JS with no third-party code, served under a strict CSP.

## Deployment

A single VPS running `docker-compose.prod.yml`: Postgres, Redis, API, worker and the demo service, behind Caddy (automatic HTTPS). Only Caddy publishes ports.

```bash
# on the server, next to docker-compose.prod.yml
cat > .env <<'ENV'
DOMAIN=webhooks.example.com
POSTGRES_PASSWORD=<random>
MASTER_ENCRYPTION_KEY=<openssl rand -base64 32>
ENV
docker compose -f docker-compose.prod.yml up -d --build
```

The `migrate` service applies the Drizzle schema before the API, worker and demo start. Keep a copy of `MASTER_ENCRYPTION_KEY`: losing it makes the stored endpoint secrets undecryptable.

## Implementation plan

See [`docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md`](docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md) for the task-by-task breakdown.

## Repo structure

```
apps/
  api/                        # Fastify, endpoints + events + replay routes
  worker/                     # BullMQ consumer, deliver orchestrator
  demo/                       # public live demo page (SSE) + fake customer endpoint
packages/
  core/                       # crypto, ids, retry schedule, signature, breaker logic
  db/                         # Drizzle schema + client
  queue/                      # BullMQ wrapper, Redis Lua scripts
  test-helpers/               # containers, app fixture, seed helpers
scripts/
  cli/                        # utility CLIs (create-client)
  chaos/                      # demo:chaos (orchestrator + fake endpoint + PNG)
docker/Dockerfile             # multi-stage image shared by api, worker and demo
docker-compose.yml            # local dev (Postgres + Redis)
docker-compose.demo.yml       # chaos demo stack (builds the image)
docker-compose.prod.yml       # VPS stack: all services + Caddy
deploy/Caddyfile              # reverse proxy, HTTPS, SSE flushing
.github/workflows/            # ci.yml
tests/integration/            # 16 Testcontainers tests
docs/superpowers/             # specs and plans
docs/chaos-runs/              # PNG of the latest chaos run
```
