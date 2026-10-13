# 📖 Study Guide — Webhook Delivery Service

> Your personal guide to **mastering your own project** (separate from the public `README.md`). Goal: be able to explain it in an interview **as if you had written it line by line**. Read it in order, with the code open alongside.

---

## 1. In one sentence

A service that **receives events through an HTTP API** and **delivers them to client URLs** reliably: signed (HMAC), with **exponential retry**, **circuit breaker**, **idempotency** and **replay**. Two separate processes, connected by a **queue**:

```
   HTTP client                    API (Fastify)                Redis                Worker (BullMQ)              Client endpoint
      │                              │                          │                        │                          │
      │  POST /events  ───────────▶  │                          │                        │                          │
      │  (Idempotency-Key)           │── SET NX idem ─────────▶ │                        │                          │
      │                              │── INSERT event(pending)─▶ Postgres                │                          │
      │                              │── queue.add(job) ──────▶ │ (queue)                │                          │
      │  ◀── 202 {id, pending} ──────│                          │── job ────────────────▶│                          │
      │                              │                          │                        │── signed POST (HMAC) ───▶│
      │                              │                          │◀─ breaker state ───────│◀── 200 / 5xx / 429 ──────│
      │                              │                          │                        │── UPDATE event(delivered)│
```

**The key mental model:** the API is the **short hot path** (validates, dedupes, writes, enqueues, responds in ~ms). The worker is the **long hot path** (network delivery, retries, breaker). They **never talk to each other directly** — only through Postgres (state) + Redis/BullMQ (queue & breaker).

---

## 2. Reading order (from the foundations up)

Follow this order; it's designed so each file builds on the previous one:

### Layer 0 — The data (the system's vocabulary)
1. `packages/db/src/schema.ts` — the 4 tables. **Start here.**
2. `packages/core/src/types.ts` — typed IDs + Zod input validation.
3. `packages/core/src/ids.ts` — ID generation (`evt_...`, ULID).

### Layer 1 — The "pure" core (logic with no network or DB, so easy to test)
4. `packages/core/src/crypto/hmac.ts` — **Standard Webhooks signature**.
5. `packages/core/src/crypto/encryption.ts` — **AES-256-GCM encryption** of secrets.
6. `packages/core/src/idempotency.ts` — the fresh/existing/conflict **decision**.
7. `packages/core/src/retry/classify.ts` — classify an HTTP response into an outcome.
8. `packages/core/src/retry/backoff.ts` — the **retry schedule** + jitter.
9. `packages/core/src/retry/retry-after.ts` — parse the `Retry-After` header.
10. `packages/core/src/breaker/fsm.ts` — the circuit breaker **state machine** (pure reference version).

### Layer 2 — The Redis / Queue layer
11. `packages/queue/src/lua/record_outcome.lua` — the **atomic** breaker in Lua.
12. `packages/queue/src/breaker.ts` — calls the Lua script from Node.
13. `packages/queue/src/delivery-queue.ts` — BullMQ config (attempts, custom backoff).

### Layer 3 — The API (ingestion)
14. `apps/api/src/server.ts` — wires up Fastify + plugins + routes.
15. `apps/api/src/routes/events.ts` — the `POST /events` route (+ list/detail).
16. `apps/api/src/services/ingestion.ts` — **the ingestion logic** (idempotency + insert + enqueue).

### Layer 4 — The worker (delivery) — THE core
17. `apps/worker/src/http-client.ts` — one signed POST, once.
18. `apps/worker/src/deliver.ts` — **orchestration of a single attempt** (breaker + delivery + recording).
19. `apps/worker/src/worker.ts` — the BullMQ consumer + **retry control**.

### Layer 5 — Tests & infra (to finish)
20. `packages/core/tests/*` — unit tests for the pure core.
21. `tests/integration/*` — the 16 end-to-end scenarios (Testcontainers).
22. `docker/Dockerfile`, `fly.toml`, `.github/workflows/` — build & deployment.

---

## 3. Concept-by-concept walkthrough

### 🗃️ The data model (`schema.ts`)
4 tables:
- **`clients`**: the tenants. `api_key_hash` (never the plaintext key).
- **`endpoints`**: the destination URLs. `secret_encrypted` (bytea) = the HMAC secret **encrypted at rest**. `archived_at` = soft delete.
- **`events`**: the ingested events. `status` ∈ `pending | delivered | dead`. `payload` as JSONB.
- **`delivery_attempts`**: **one row per delivery attempt** (status code, duration, error class). This is your audit trail.

**Be able to explain:** why a separate `delivery_attempts` table? → to keep **the history of every try** (observability + debugging), not just the latest state. The `uniqueIndex(eventId, attemptNumber)` prevents duplicate attempts.
**Indexes to understand:** `events_endpoint_status_idx (endpointId, status, createdAt)` serves listing queries filtered by endpoint + status. `endpoints_client_active_idx ... WHERE archived_at IS NULL` = **partial index** (only indexes active endpoints → smaller, faster).

### 🆔 Typed IDs (`types.ts`, `ids.ts`)
Prefixed IDs + ULID: `cl_`, `ep_`, `evt_`, `da_`. Zod validates the format at input. **Why ULID and not UUID?** ULID is **time-sortable** (lexicographic = chronological), handy for sorting/pagination.

### ✍️ HMAC signature (`crypto/hmac.ts`) — ⭐ interview concept
We sign `"{id}.{timestamp}.{body}"` with HMAC-SHA256(secret), base64-encoded, prefixed with `v1,`. The client replays the same computation with its secret and compares.
- **Why sign?** So the client can **prove the event really comes from you** (authenticity + integrity).
- **Why include the `timestamp`?** Anti-**replay attack** (the client can reject an event that is too old).
- **`timingSafeEqual`**: **constant-time** comparison → prevents a *timing attack* (guessing the signature byte by byte by measuring response time). **NEVER** compare signatures with `===`.
- Format aligned with **Standard Webhooks** (`webhook-id/timestamp/signature` headers).

### 🔐 Secret encryption (`crypto/encryption.ts`) — ⭐ interview concept
Each endpoint's HMAC secret is **encrypted at rest** with **AES-256-GCM**. Stored buffer layout: `[IV 12B | tag 16B | ciphertext]`.
- **GCM = *authenticated* encryption**: the `tag` guarantees the ciphertext hasn't been tampered with (modify 1 byte and `decipher.final()` throws).
- **Random IV** on every encryption (never reused) → 2 encryptions of the same secret produce 2 different ciphertexts.
- Separate **master key** (32 bytes), injected via env (`MASTER_ENCRYPTION_KEY`), **never in the DB**. If the DB leaks, the secrets stay unreadable without the master key.

### 🔁 Idempotency (`idempotency.ts` + `services/ingestion.ts`) — ⭐ interview concept
Problem: the client may send the same request twice (network retry). We do **not** want to create 2 events.
- The client sends an `Idempotency-Key` header.
- We store in Redis `idem:{clientId}:{key}` → `{eventId, payloadSha256}`, **24h TTL**, with **`SET ... NX`** (only writes if absent → **atomic**).
- 3 cases (`idempotencyDecide`):
  - **fresh** (key absent) → we create the event.
  - **existing** (same key + **same payload hash**) → we return **the same eventId** (200), no duplicate.
  - **conflict** (same key, **different payload**) → **422** (the client is reusing a key for different content = error).
- **Be able to explain:** `SET NX` is the atomic building block that makes ingestion safe even under concurrent requests.

### ⏱️ Exponential retry (`retry/backoff.ts`, `classify.ts`, `delivery-queue.ts`) — ⭐
- **Schedule**: `[0, 1s, 10s, 1min, 10min, 1h, 6h]` → **7 attempts** max.
- **±20% jitter** (`backoffMs`): we randomize the delay to **avoid the thundering herd** (all events retrying at exactly the same moment).
- **`classifyOutcome`** turns a response into a category: `success` (2xx/3xx), `http_4xx`, `http_5xx`, `throttle` (429), `timeout`, `network`.
- **What gets retried?** 5xx / timeout / network → **retry**. 4xx (except 429) → **terminal** (dead, no retry: the content is at fault, retrying won't change anything). 429 → retry honoring `Retry-After`.
- BullMQ drives retries via `attempts: 7` + a **custom `backoffStrategy`** that calls your `backoffMs`.

### 🚦 Circuit breaker (`breaker/fsm.ts`, `lua/record_outcome.lua`, `breaker.ts`) — ⭐⭐ THE centerpiece
Idea: if an endpoint is **down**, stop hammering it. 3 states:
- **closed** (normal): we deliver. After **5 consecutive failures** → **open**.
- **open** (cut off): we **stop delivering** and postpone. After a **cooldown** (30s initially) → **half_open**.
- **half_open** (probing): we let **ONE single** test event through. If it succeeds → **closed** (healed). If it fails → **open**, and we **double** the cooldown (up to 30 min max) = *exponential backoff at the endpoint level*.

**The two golden subtleties:**
1. **Why Lua?** (`record_outcome.lua`). The breaker is **shared** across 10 concurrent workers (and several processes). Read state → decide → write back must be **atomic**, otherwise two workers step on each other (race condition). A Lua script in Redis **runs atomically** (nothing interleaves). This is the finest technical point of the project.
2. **The "probe lock" in half_open** (`deliver.ts`): when the breaker goes half_open, we want **only one** test event, not 10. We take a Redis lock `SET NX EX 5`: the first worker gets it and probes, the others get `breaker_skip`. Avoids the *thundering herd* on reopening.

**Be able to explain:** why does a **4xx count as "success" for the breaker**? Because the endpoint is **alive** (it responds), it just rejects that content. The breaker protects against **dead** endpoints (5xx/timeout), not against a bad payload.

### 📮 Ingestion (`services/ingestion.ts`)
The short hot path, in order:
1. `findEndpointForClient` — does the endpoint exist and belong to this client? (multi-tenant isolation)
2. payload hash + idempotency `SET NX` → fresh/existing/conflict.
3. if fresh: `INSERT event (status pending)`.
4. `queue.add('deliver', {eventId}, {jobId: eventId})` — **`jobId: eventId`** = BullMQ deduplication (the same event cannot create 2 jobs).
5. returns `created` (202) or `existing` (200) or `conflict` (422).

### 🚚 Delivery (`worker/deliver.ts` + `http-client.ts` + `worker.ts`) — ⭐⭐
`deliver()` orchestrates **one attempt**:
1. loads event + endpoint (join).
2. **reads the breaker**: if `open` → `breaker_skip` (postpone). If `half_open` → tries to acquire the probe lock.
3. decrypts the secret, **signs** (`http-client.deliverOnce` → signed POST via `undici`).
4. records a `delivery_attempts` row (**attemptNumber = max(existing)+1**).
5. **records the outcome in the breaker** (success/failure) + updates the event (`delivered` / `dead`) or returns `retry`.

`worker.ts` translates the result of `deliver()` into **BullMQ control** — and this is THE subtlest trick:
- `success` → return (job OK).
- `breaker_skip` or `retry` with a 429 override → **`job.moveToDelayed()` THEN `throw new DelayedError()`**. The `DelayedError` tells BullMQ "postpone without counting this as a failure" → **it doesn't burn an attempt**. Crucial: a cut-off endpoint must not consume your 7 tries.
- `dlq` → `throw new UnrecoverableError()` → BullMQ marks a **permanent failure** (ignores remaining attempts).
- normal `retry` → `throw new Error()` → BullMQ counts the attempt + applies your backoff.
- **Marking `dead`**: either in `deliver` (immediate 4xx), or in `worker.on('failed')` when `attemptsMade >= maxAttempts` (all 7 tries exhausted for 5xx/network).

---

## 4. The full journey of an event (to recite)

1. `POST /events` with `Idempotency-Key` → `events.ts` validates (auth, Zod).
2. `ingestEvent`: endpoint OK → idem `SET NX` → `INSERT event(pending)` → `queue.add(jobId=eventId)` → **202** in a few ms.
3. A BullMQ worker picks up the job → `deliver()`.
4. Breaker `closed` → decrypts secret → **HMAC-signed POST** to the URL (10s timeout).
5. **200** response → `delivery_attempt` recorded, breaker `success`, `event.status = delivered`. ✅
6. **503** response → `delivery_attempt`, breaker `failure`, `throw Error` → BullMQ reschedules in ~1s (then 10s, 1min…).
7. After **5 failures** on the endpoint → breaker **open** → subsequent events are `moveToDelayed` (without burning a try) until the cooldown.
8. Cooldown elapsed → **half_open** → one test event goes through (probe lock). OK → **closed** (recovery). KO → **open**, cooldown ×2.
9. **429** with `Retry-After: 30` → retry scheduled at exactly +30s.
10. **400** → `event.status = dead` immediately (no retry). ☠️
11. 7 5xx tries exhausted → `event.status = dead` via `worker.on('failed')`.
12. `GET /events/:id` → status + **all attempts** (audit).
13. `POST /replay` → recreates a job for a dead/pending event.

---

## 5. Likely interview questions (+ your answers)

- **"Explain your architecture."** → API (ingestion, short hot path) + Worker (delivery, long hot path), decoupled by Postgres (state) + BullMQ/Redis (queue). Why decouple: respond to the client fast, absorb spikes, retry without blocking the API.
- **"How do you guarantee idempotency?"** → Idempotency-Key + Redis `SET NX` + payload hash → fresh/existing/conflict.
- **"How does your circuit breaker stay correct under 10 concurrent workers?"** → **atomic** read-modify-write **in Lua** inside Redis + **probe lock** in half_open. ⭐ (your best answer)
- **"Why doesn't a 4xx retry but a 5xx does?"** → 4xx = permanent content-side error; 5xx/timeout = transient outage. And 4xx = breaker "success" because the endpoint is alive.
- **"How do you avoid burning an attempt when the breaker is open?"** → `moveToDelayed` + `DelayedError` (BullMQ doesn't count it as a failure).
- **"Secret security?"** → HMAC signing (authenticity) + secrets **encrypted with AES-256-GCM at rest**, master key outside the DB + `timingSafeEqual`.
- **"How do you test it?"** → unit tests on the pure core (logic without I/O) + **Testcontainers** (real Postgres + Redis) for 16 end-to-end scenarios (happy path, retry, DLQ, breaker, idempotency, cross-client…).

---

## 6. Quick glossary
- **Hot path**: the latency-critical path.
- **DLQ (dead letter queue)**: here, the `dead` status = event abandoned after a terminal failure/exhaustion.
- **Backpressure / thundering herd**: a simultaneous surge that we smooth out (jitter, probe lock).
- **FSM**: finite state machine (the breaker).
- **Multi-tenant**: several isolated clients (everything is scoped by `clientId`).
- **At-least-once**: the delivery model (an event can be delivered ≥1 times → hence the value of the signature + client-side idempotency).

---

## 7. How to review (method)
1. Read a file from the §2 list, **close it, and re-explain it out loud** (or write 3 lines).
2. For each ⭐ concept, practice answering the §5 interview question **without looking**.
3. Run `pnpm dev` + the README smoke test → **watch** an event go from `pending` to `delivered`.
4. Run `pnpm demo:chaos` → **watch** the breaker open/close on the PNG.
5. When you can recite §4 from memory → **you've mastered your project.**
