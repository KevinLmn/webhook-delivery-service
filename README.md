# Webhook Delivery Service

[![CI](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml/badge.svg)](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml)

A Node/TypeScript service that takes events in through an HTTP API and delivers them to your customers' HTTPS endpoints, reliably. The API answers in milliseconds with `202 Accepted`; a separate BullMQ worker does the slow, failure-prone part: it signs each request (HMAC, [Standard Webhooks](https://www.standardwebhooks.com) headers), retries transient failures on an exponential schedule with jitter, honors `Retry-After`, stops hammering dead endpoints with a per-endpoint circuit breaker shared across workers (an atomic Lua script in Redis), and keeps an audit row for every HTTP attempt. Ingestion is idempotent (mandatory `Idempotency-Key`), tenants are isolated, endpoint secrets are encrypted at rest, and any finished event can be replayed.

> Showcase project. Not a production service used by real customers.

**Live demo**: **[webhook.kevinlemniai.fr](https://webhook.kevinlemniai.fr)**. Press the button to trigger an outage scenario and watch retries, the circuit breaker and dead letters play out in real time (see [Live demo page](#live-demo-page)).

**Studying the code?** [`STUDY-GUIDE.md`](STUDY-GUIDE.md) gives a file-by-file reading order, the concepts each file teaches, interview questions and exercises.

---

## Contents

- [Architecture](#architecture)
- [Request lifecycle](#request-lifecycle)
- [Guarantees](#guarantees)
- [API](#api)
- [Data model](#data-model)
- [Run locally](#run-locally) · [Tests](#tests) · [Chaos demo](#chaos-demo) · [Live demo page](#live-demo-page)
- [Deployment](#deployment)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Limits and known gaps](#limits-and-known-gaps)
- [Next: ingest](#next-ingest)
- [Repo structure](#repo-structure)

---

## Architecture

```mermaid
flowchart LR
  Client[Client] -->|POST /events| API[API · Fastify]
  API -->|SET NX idempotency key| R[(Redis)]
  API -->|INSERT event pending| DB[(Postgres)]
  API -->|queue.add jobId=eventId| Q[BullMQ queue]
  Q --> W[Worker · BullMQ x10]
  W -->|EVALSHA breaker script| R
  W -->|signed HTTP POST| EP[Customer endpoint]
  W -->|INSERT delivery_attempt / UPDATE status| DB
  W -->|retry with backoff / moveToDelayed| Q
  W -->|terminal or exhausted| DEAD[status = dead]
```

Two processes built from the same Docker image, which never call each other. They only share state:

| Component | Role |
|---|---|
| **API** (`apps/api`, Fastify) | The short hot path: auth, validation, idempotency, insert, enqueue, `202`. Also endpoint CRUD, event reads and replay. |
| **Worker** (`apps/worker`, BullMQ) | The long hot path: breaker check, decrypt secret, sign, POST (10 s timeout), record the attempt, decide success / retry / dead. Concurrency 10 per process. |
| **Postgres** | Durable source of truth: `clients`, `endpoints`, `events`, `delivery_attempts`. |
| **Redis** | Shared volatile state: BullMQ jobs and delays, breaker state per endpoint, idempotency keys, probe locks. |
| **Demo** (`apps/demo`) | Public page + fake customer endpoint that drives the real API (the only piece exposed to the internet). |

---

## Request lifecycle

### Ingestion: `POST /events` (`apps/api/src/routes/events.ts` → `services/ingestion.ts`)

1. **Auth.** `Authorization: Bearer <api key>`. The key is checked with argon2id against `clients.api_key_hash`; a verified token is cached in memory by its SHA-256 for 5 minutes (argon2 costs tens of ms by design).
2. **Validation.** `Idempotency-Key` header required (`400` otherwise). Zod checks the body: `endpoint_id` (`ep_<ULID>`), `event_type` (`order.created` style), `payload` ≤ 1 MB serialized.
3. **Tenant check.** The endpoint must exist, belong to this client and not be archived, otherwise `404` (same answer for "not yours" and "doesn't exist", so ids can't be probed).
4. **Idempotency claim.** One atomic `SET idem:{clientId}:{key} {eventId, payloadSha256} EX 86400 NX`.
   - Key was free → this request owns it, continue.
   - Key exists with the same payload hash → `200` with the **original** event id. Nothing else happens.
   - Key exists with a different payload → `422 idempotency_conflict`.
5. **Insert** the event in Postgres with `status = 'pending'`.
6. **Enqueue** a BullMQ job `{ eventId }` with `jobId = eventId`, so the same event can't produce two jobs.
7. **Answer `202`** `{ id, status: "pending", endpoint_id }`. Delivery has not started yet.

### Delivery: one job attempt (`apps/worker/src/worker.ts` → `deliver.ts` → `http-client.ts`)

1. Load the event and its endpoint (one join).
2. **Read the breaker** (`EVALSHA record_outcome.lua` with event `read`):
   - `open` → don't call the endpoint. Reschedule the job for the remaining cooldown (at least 1 s) with `moveToDelayed` + `DelayedError`: **no attempt is consumed**.
   - `half_open` → try to take the probe lock (`SET breaker:{ep}:probe_lock 1 EX 5 NX`). One worker probes; the others are rescheduled 1 s later, again without consuming an attempt.
3. Decrypt the endpoint secret (AES-256-GCM), sign `"{event id}.{timestamp}.{body}"`, POST with `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`. The timestamp is the attempt's, not the ingestion's.
4. Insert a `delivery_attempts` row (status code, duration, error class, first 1,000 chars of the response).
5. Classify and decide:

| Result | Breaker records | Event | Job |
|---|---|---|---|
| 2xx / 3xx | success | `delivered` | completed |
| 4xx except 429 | **success** (endpoint is alive, it rejected this payload) | `dead` | `UnrecoverableError`, no retry |
| 429 with a valid `Retry-After` (≤ 6 h) | failure | `pending` | `moveToDelayed(Retry-After)` + `DelayedError`, no attempt consumed |
| 429 without one, 5xx, timeout, network error | failure | `pending` | throw → BullMQ counts the attempt and applies the backoff |
| 7th attempt fails | failure | `dead` (in the worker's `failed` handler) | failed |

Read your events back with `GET /events/:id`: status plus every attempt, in order.

---

## Guarantees

| Property | What you get | Where it is enforced |
|---|---|---|
| **Delivery** | **At-least-once.** A worker crash after a successful POST but before the `delivered` update re-runs the job, so an endpoint can receive the same event twice. Receivers dedupe on `webhook-id` (= the event id, stable across retries and replays). | BullMQ stalled-job recovery, `deliver.ts` |
| **Ingestion idempotency** | Same client + same `Idempotency-Key` + same payload within 24 h → same event id, one row, one job. Same key with another payload → `422`. Keys are scoped per client. | `ingestion.ts` (Redis `SET NX`) |
| **Ordering** | **None.** 10 concurrent jobs per worker, independent retry timers, jitter: event B can arrive before event A, even on one endpoint. | by design |
| **Retries** | 7 attempts max. Delay before each attempt: 0, 1 s, 10 s, 1 min, 10 min, 1 h, 6 h, each ±20 % jitter. Worst case ≈ 7 h 11 min from first to last attempt (plus jitter and up to 10 s timeout per attempt). | `packages/core/src/retry/backoff.ts`, `delivery-queue.ts` |
| **Retry-After** | Honored on `429`, as seconds or HTTP date. A value above 6 h is ignored (normal backoff applies), not clamped. | `retry-after.ts`, `deliver.ts` |
| **Permanent failures** | 4xx other than 429 → `dead` after one attempt. Retrying a payload the receiver rejects changes nothing. | `classify.ts`, `deliver.ts` |
| **Circuit breaker** | Per endpoint, shared by every worker process. See below. | `record_outcome.lua` |
| **Authenticity** | HMAC-SHA256 over `id.timestamp.body` with a per-endpoint secret. | `packages/core/src/crypto/hmac.ts` |
| **Secrets at rest** | Endpoint secrets stored AES-256-GCM encrypted (`iv ‖ tag ‖ ciphertext`), master key only in the environment. API keys stored as argon2id hashes. | `encryption.ts`, `password.ts` |

### Circuit breaker

| From | Event | To | Effect |
|---|---|---|---|
| `closed` | success | `closed` | failure counter reset to 0 |
| `closed` | failure | `closed` / `open` | counter + 1; at **5 consecutive failures** → `open`, cooldown **30 s** |
| `open` | any, once `openedAt + cooldown ≤ now` | `half_open` | lazy: noticed by the next script call, nobody wakes it up |
| `open` | failure (an in-flight request) | `open` | ignored, cooldown not extended |
| `half_open` | success (the probe) | `closed` | cooldown reset to 30 s |
| `half_open` | failure (the probe) | `open` | cooldown **doubled**, capped at **30 min** (30 s → 1 min → 2 min → … → 30 min) |

State is a JSON blob in `breaker:{endpointId}` with a sliding 24 h TTL. Every read-decide-write runs inside one Lua script, so concurrent workers can't interleave. `packages/core/src/breaker/fsm.ts` is a pure TypeScript model of the same rules, for unit tests.

---

## API

All routes except `/health` and `/ready` need `Authorization: Bearer <api key>`.

| Method | Route | Answers |
|---|---|---|
| `POST` | `/endpoints` | `201` with the signing secret (`whsec_…`, shown only once). `url` must be `https://`. |
| `GET` | `/endpoints` | active endpoints |
| `DELETE` | `/endpoints/:id` | `204`, soft delete (`archived_at`); new events to it get `404` |
| `POST` | `/events` | `202` created · `200` idempotent repeat · `400` · `401` · `404` · `422` |
| `GET` | `/events?status=&endpoint_id=&limit=` | newest first, `limit` default 50, max 200 |
| `GET` | `/events/:id` | event + all attempts |
| `POST` | `/events/:id/replay` | `200` re-queued (from `delivered` or `dead`) · `409` still pending · `404` |
| `GET` | `/health`, `/ready` | liveness; readiness pings Redis |

### Standard Webhooks interoperability note

The implementation follows the Standard Webhooks **shape** (signed string `id.timestamp.body`, `webhook-*` headers, `v1,<base64>` scheme), but uses the secret **as raw UTF-8** as the HMAC key. The Svix variant base64-decodes the secret after stripping the `whsec_` prefix before HMAC. Bit-for-bit Svix consumers will therefore not validate our signatures without adapting their HMAC key. The header format and the signed string remain compatible.

---

## Data model

```
clients (id cl_…, name, api_key_hash UNIQUE, created_at)
   │ 1..n  ON DELETE CASCADE
endpoints (id ep_…, client_id, url, secret_encrypted bytea, description, archived_at, created_at)
   │ 1..n  (no cascade: history is kept)
events (id evt_…, endpoint_id, event_type, payload jsonb, status, delivered_at, dead_at, created_at)
   │ 1..n  ON DELETE CASCADE
delivery_attempts (id da_…, event_id, attempt_number, attempted_at, status_code, duration_ms,
                   error_class, response_body_excerpt)
```

- IDs are `<prefix>_<ULID>`: readable in logs, time-sortable, validated by Zod at the edge.
- `events.status` is `text` + `CHECK (status IN ('pending','delivered','dead'))`.
- Indexes: `events (endpoint_id, status, created_at)` for filtered listings; partial `endpoints (client_id) WHERE archived_at IS NULL`; unique `delivery_attempts (event_id, attempt_number)`, which also serves per-event lookups.
- Breaker skips don't write attempt rows: the audit log only records real HTTP calls.
- Schema in `packages/db/src/schema.ts` (Drizzle); generated SQL in `packages/db/drizzle/`.

Redis keys:

| Key | Content | TTL |
|---|---|---|
| `idem:{clientId}:{idempotencyKey}` | `{ eventId, payloadSha256 }` | 24 h |
| `breaker:{endpointId}` | `{ state, openedAt, failCount, openDurationMs }` | 24 h, refreshed on every call |
| `breaker:{endpointId}:probe_lock` | `1` | 5 s |
| `breaker:skip_count:{endpointId}` | deliveries postponed by an open breaker | 1 h |
| `bull:webhook-deliveries:*` | BullMQ jobs; the last 1,000 completed and 5,000 failed are kept | managed by BullMQ |

---

## Run locally

Prerequisites: Node 22, pnpm 9, Docker Compose.

```bash
nvm use
pnpm install

# local infra (Postgres + Redis)
docker compose up -d

# schema
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

# create an endpoint (https only)
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
# → 202. Send the exact same request again → 200 with the same id.

# check the status after ~5s
curl -s http://localhost:3000/events/evt_xxx -H "Authorization: Bearer $API_KEY"
# → status: "delivered", attempts: [ { attempt_number: 1, status_code: 200, ... } ]
```

## Tests

```bash
pnpm typecheck
pnpm lint                # Biome
pnpm test:unit           # pure core + demo scenario; the breaker Lua test starts a Redis container
pnpm test:integration    # 16 end-to-end tests (Testcontainers Postgres + Redis), ~3 min
```

Integration tests run the real API and worker in-process against real containers. They compress time through two test-only hooks: the retry schedule becomes `[0, 50, 100, 200, 400, 800, 1600]` ms and the breaker cooldown 1 s (`tests/integration/vitest-setup.ts`). Covered: happy path, retry then success, 7 attempts then dead, 4xx dead in one attempt, 429 + `Retry-After`, breaker opening, idempotency (hit, conflict, missing key), replay (dead, delivered, pending), auth, cross-tenant isolation, archived endpoint.

## Chaos demo

`pnpm demo:chaos` orchestrates an end-to-end run on your machine:

1. spawns a local fake endpoint scripted in 4 phases (200 OK → 500 → 50/50 → 200 OK);
2. boots a Postgres + Redis + API + Worker stack via `docker-compose.demo.yml`;
3. pushes 100 events spread over 90 s (so traffic keeps flowing through the outage), samples the system state at 1 Hz for ~140 s;
4. generates an annotated PNG in `docs/chaos-runs/`.

```bash
pnpm demo:chaos
```

The run takes ~3 min.

### Latest run

![Latest chaos run](docs/chaos-runs/2026-10-13-05-48.png)

What it shows: the endpoint starts returning `500` at t=10 s; after 5 consecutive failures the breaker opens (~t=13 s) and the worker stops hammering it, so events queue up as `pending` instead of burning retries. After the 30 s cooldown the breaker goes `half_open`, the probe succeeds, it closes again and the backlog drains. Through the 50/50 phase, retries absorb the failures. End state: 100/100 delivered, 0 dead.

## Live demo page

`apps/demo` serves a public page with a single button: **Run outage scenario**.

- A run creates a fresh endpoint, then pushes 1,000 `order.created` events through the real API over 90 s.
- The endpoint is a fake customer server on an internal port. It verifies every HMAC signature, then plays 4 phases: healthy, a 30 s outage (500), a flaky phase where one request in three fails, and recovery. The flaky pattern is deterministic, so the breaker's probe always lands and every run shows the backlog draining. 1 event in 25 carries a payload it rejects with `422`, to show the dead-letter path.
- The service samples Postgres and Redis every second and streams the state to every open page over Server-Sent Events, so all visitors watch the same run.
- Abuse limits: one run at a time, one run per IP every 3 minutes, at most 300 concurrent viewers, and visitors can't supply a URL. The API, worker, Postgres and Redis are never exposed.
- The last finished run is kept in Redis, so the page is never empty after a restart.

The page is plain HTML/CSS/JS with no third-party code, served under a strict CSP.

---

## Deployment

A single VPS running `docker-compose.prod.yml`: Postgres 16, Redis 7 (AOF on, `maxmemory 128mb`, `noeviction` so BullMQ data is never silently evicted), a one-shot `migrate` service, API, worker and the demo service. Nothing listens on a public interface except the reverse proxy; the demo page is bound to `127.0.0.1:3100`.

```bash
# on the server, next to docker-compose.prod.yml
cat > .env <<'ENV'
POSTGRES_PASSWORD=<random>
MASTER_ENCRYPTION_KEY=<openssl rand -base64 32>
# bundled Caddy with automatic HTTPS (skip these two if the host already runs a reverse proxy)
COMPOSE_PROFILES=caddy
DOMAIN=webhooks.example.com
ENV
docker compose -f docker-compose.prod.yml up -d --build
```

With an existing reverse proxy, point it at `127.0.0.1:3100` and disable response buffering so the live stream (SSE) is not held back. For a host Caddy:

```
webhooks.example.com {
	reverse_proxy 127.0.0.1:3100 {
		flush_interval -1
	}
}
```

**Continuous deployment**: every push to `main` runs CI (typecheck, lint, unit and integration tests); when it passes, the `deploy` job SSHes into the VPS with a dedicated key that `authorized_keys` pins to [`deploy/deploy.sh`](deploy/deploy.sh) (forced command, no shell). The script resets to `origin/main`, rebuilds the stack and waits for `/health`; the job then checks the public URL. Deploys are serialized (`concurrency: deploy-production`).

The `migrate` service applies the Drizzle schema (`drizzle-kit push --force`) before the API, worker and demo start. Keep a copy of `MASTER_ENCRYPTION_KEY`: losing it makes the stored endpoint secrets undecryptable.

---

## Design decisions and trade-offs

**Why `202` and a queue instead of delivering inline?** Customer endpoints are slow, flaky and outside our control. Delivering inside the request would tie our API latency and availability to theirs, and retries spread over hours would be impossible. The API only does fast work (one Redis call, one insert, one enqueue) and answers; the worker absorbs bursts at its own pace.

**Why BullMQ (Redis) rather than a Postgres-backed queue?** It gives delayed jobs, per-job attempt counts with a custom backoff function, job locks with stalled-job recovery, and `UnrecoverableError` / `DelayedError` semantics out of the box, and Redis is already there for the breaker and idempotency. The cost: a job and its event row live in two systems that can't share a transaction (see gaps). A Postgres queue (`SELECT … FOR UPDATE SKIP LOCKED`) would allow insert + enqueue in one transaction, at the price of building delays, backoff and recovery by hand.

**Why a Lua script for the breaker?** The breaker is a read-modify-write on shared state, hit by 10 concurrent jobs per process and by every worker process. `GET` then `SET` from Node would let two workers both read `failCount = 4` and both write 5 (one failure lost), or both flip to `open` with different timestamps. Redis runs a script atomically, so the whole transition is one indivisible step, in one round trip. `WATCH`/`MULTI` would also be correct, but it retries on contention, which is exactly when the breaker is busiest.

**Why does a breaker-open postponement not consume an attempt?** An endpoint that is down for an hour would otherwise burn all 7 attempts of every queued event while nobody even called it. `moveToDelayed` + `DelayedError` tells BullMQ "later", not "failed".

**Why is a 4xx a breaker success?** The breaker protects us from dead endpoints. A `422` proves the endpoint is up; it rejects that payload, which is a per-event problem (→ `dead`), not a per-endpoint one.

**Why sign with a fresh timestamp per attempt?** Receivers reject signatures outside a tolerance window to stop replays. A retry 6 h later carrying the ingestion timestamp would be rejected by a correct receiver.

**Why idempotency in Redis rather than a unique constraint in Postgres?** `SET NX EX` gives an atomic claim and automatic 24 h expiry in one call. A `UNIQUE (client_id, idempotency_key)` column would be stronger (same transaction as the insert) but needs a cleanup job for expiry. See the gap below.

**Why encrypt endpoint secrets instead of hashing them?** The worker needs the plaintext to compute the HMAC, so a one-way hash is not an option. GCM also authenticates the ciphertext: a tampered row fails to decrypt instead of producing a wrong key.

**What would break first at scale?**
- **One shared queue for all endpoints.** A slow endpoint (10 s timeouts) holds worker slots until its breaker opens; there is no per-endpoint concurrency limit or fairness between tenants.
- **Postgres write path.** Each event is an autocommit `INSERT` (one commit, one WAL flush), each attempt another one, plus a `MAX(attempt_number)` read. No batching, no partitioning, no retention: `events` and `delivery_attempts` grow forever. This is what the follow-up project measures (see [Next: ingest](#next-ingest)).
- **Auth cache misses.** An unknown token scans every client and runs argon2 on each. Fine for a handful of tenants, linear beyond (fix: put a client id hint in the token).
- **One Redis.** Queue, breaker and idempotency share a single 128 MB node with `noeviction`: when it is full, writes fail and so does ingestion.
- **Half-open churn.** While a breaker is half-open, every queued job for that endpoint wakes up every second, fails to get the probe lock and goes back to sleep.

---

## Limits and known gaps

Deliberately out of V1 (see the [design spec](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md), section 10): public signup, secret rotation, batch replay, DLQ notifications, production-grade observability (Pino logs only), rate limiting on the public API, client SDKs, multi-region. The spec's deployment section describes the original Fly.io target; the service now runs on a single VPS (see [Deployment](#deployment)).

Known gaps in the current code, each documented in a comment where it lives:

- **Idempotency claim before insert.** The Redis key is set before the Postgres insert. If the insert or the enqueue fails, a retry with the same key gets `200` and an event id that was never stored (24 h window). Accepted in the spec for V1.
- **Insert and enqueue are not atomic.** A crash between them leaves a `pending` event with no job, and nothing sweeps those up. Fix: transactional outbox, or a periodic re-enqueue of old `pending` rows.
- **No graceful shutdown in the API and the worker.** No `SIGTERM` handler: a deploy kills in-flight jobs, BullMQ re-runs them once their lock expires, and some events are delivered twice (still within at-least-once). `worker.close()` on `SIGTERM` would fix it.
- **Probe lock TTL (5 s) shorter than the HTTP timeout (10 s).** A slow probe can let a second probe through.
- **A `429` with `Retry-After` never consumes an attempt**, so an endpoint that always throttles keeps an event `pending` indefinitely (the breaker still spaces the calls).
- **No ordering**, and no `retrying` status: an event is `pending` from ingestion until it is `delivered` or `dead`.
- **Readiness** checks Redis but not Postgres.
- **Schema changes** go through `drizzle-kit push --force`, not versioned migrations.

---

## Next: ingest

This service writes one row per event, one transaction at a time, which is fine at demo traffic. The follow-up project, **ingest**, isolates that write path and pushes it: the same event-ingestion service written twice (Node/Fastify and Go), on one Postgres, under the same k6 load, on a dedicated Linux bench machine. It starts below the application, with `pgbench` measuring Postgres alone: how many events per second it absorbs with 1, 100 and 1,000 events per transaction, and why (commit cost and WAL flushes, checkpoints, and a hidden variable found on the way: the SSD's state without TRIM). Next come batching from a real client, `COPY`, connection pools, index cost, partitioning, and Node's event loop against Go's scheduler, measured with percentiles.

Study notes on the first results and how they connect to this codebase (in French): [`docs/next-ingest.md`](docs/next-ingest.md).

---

## Repo structure

```
apps/
  api/                        # Fastify: plugins (config, db, queue, auth), routes, services
  worker/                     # BullMQ consumer, deliver orchestrator, HTTP client
  demo/                       # public live demo page (SSE) + fake customer endpoint
packages/
  core/                       # pure logic: ids, Zod types, crypto, idempotency, retry, breaker FSM
  db/                         # Drizzle schema + client
  queue/                      # BullMQ queue config, Redis client, breaker Lua script + bridge
  test-helpers/               # containers, app fixture, seed helpers, fake endpoint
scripts/
  cli/                        # utility CLIs (create-client)
  chaos/                      # demo:chaos (orchestrator + fake endpoint + PNG)
docker/Dockerfile             # multi-stage image shared by api, worker and demo
docker-compose.yml            # local dev (Postgres + Redis)
docker-compose.demo.yml       # chaos demo stack (builds the image)
docker-compose.prod.yml       # VPS stack: all services + Caddy
deploy/                       # Caddyfile (HTTPS, SSE flushing), deploy.sh (CD forced command)
.github/workflows/ci.yml      # typecheck, lint, unit, integration, deploy
tests/integration/            # 16 Testcontainers tests
docs/superpowers/             # design spec and implementation plans
docs/chaos-runs/              # PNG of the latest chaos run
docs/next-ingest.md           # follow-up project notes (French)
STUDY-GUIDE.md                # how to read and master this codebase
```
