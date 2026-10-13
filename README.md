# Webhook Delivery Service

[![CI](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml/badge.svg)](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml)

Node/TypeScript service that ingests events through an HTTP API and delivers them to third-party client endpoints, with exponential retry, circuit breaker, idempotency keys and manual replay. API model aligned with [Standard Webhooks](https://www.standardwebhooks.com).

> Showcase project. Not a production service used by real customers.

**Live demo**: https://vitrine-webhook-demo.fly.dev/ready (Fly.io single region `cdg` + Neon Postgres + Upstash Redis).

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
3. pushes 100 events over 5 s, samples the system state at 1 Hz for ~140 s;
4. generates an annotated PNG in `docs/chaos-runs/`.

```bash
pnpm demo:chaos
```

The run takes ~3 min. The PNG illustrates the circuit breaker mechanics: opening during the outage phase, `half_open` transition after the cooldown, back to `closed` on recovery.

### Latest run

![Latest chaos run](docs/chaos-runs/<FILE_STEM>.png)

## Architecture

See [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md).

## Deployment

Multi-stage Docker image (`docker/Dockerfile`) shared by the API and the Worker. Fly topology: a single app with two process groups (`api` exposed over HTTP, `worker` in the background).

```bash
flyctl deploy --app vitrine-webhook-demo
```

Drizzle migrations run automatically before each release via `release_command` in `fly.toml`. Secrets managed with `flyctl secrets set` (`DATABASE_URL`, `REDIS_URL`, `MASTER_ENCRYPTION_KEY`).

CD configured: a push to `main` triggers `.github/workflows/deploy.yml`, which calls `flyctl deploy --remote-only`.

## Implementation plan

See [`docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md`](docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md) for the task-by-task breakdown.

## Repo structure

```
apps/
  api/                        # Fastify, endpoints + events + replay routes
  worker/                     # BullMQ consumer, deliver orchestrator
packages/
  core/                       # crypto, ids, retry schedule, signature, breaker logic
  db/                         # Drizzle schema + client
  queue/                      # BullMQ wrapper, Redis Lua scripts
  test-helpers/               # containers, app fixture, seed helpers
scripts/
  cli/                        # utility CLIs (create-client)
  chaos/                      # demo:chaos (orchestrator + fake endpoint + PNG)
docker/Dockerfile             # multi-stage API + Worker image
docker-compose.yml            # local dev (Postgres + Redis)
docker-compose.demo.yml       # chaos demo stack (builds the image)
fly.toml                      # Fly deployment (api + worker process groups)
.github/workflows/            # ci.yml + deploy.yml
tests/integration/            # 16 Testcontainers tests
docs/superpowers/             # specs and plans
docs/chaos-runs/              # PNG of the latest chaos run
```
