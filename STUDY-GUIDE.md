# Study Guide: Webhook Delivery Service

A guide to mastering this codebase line by line, separate from the public [`README.md`](README.md) (which says *what* the service guarantees). This file says *how to read it*: in which order, what to look for in each file, which concepts each one teaches, and how to check you really understood. The goal is to explain any line of it in an interview, including its trade-offs and its known gaps.

How to use it:

1. Keep the code open next to this file and follow [§2](#2-reading-order) in order. Each stop has a check question; answer it out loud before opening the answer.
2. Then read the concept chapters ([§3](#3-concepts-in-depth)), which tie files together.
3. Do at least three exercises from [§6](#6-exercises). Changing code and predicting the effect is what turns reading into mastery. (Revert your changes afterwards.)
4. Finish with the interview questions ([§5](#5-interview-questions-with-model-answers)), without looking at the answers.

Setup once: `pnpm install`, Docker running, then `pnpm typecheck && pnpm test:unit` should be green. `pnpm test:integration` takes ~3 min.

---

## 1. The mental model

```
 client            API (Fastify)                 Redis                    Worker (BullMQ, x10)          customer endpoint
   │ POST /events      │                            │                              │                            │
   │ Idempotency-Key ─▶│── SET idem:… NX EX 86400 ─▶│                              │                            │
   │                   │── INSERT event (pending) ──────▶ Postgres                 │                            │
   │                   │── queue.add(jobId=eventId) ▶│ bull:webhook-deliveries     │                            │
   │◀── 202 {id} ──────│                            │── job ──────────────────────▶│                            │
   │                   │                            │◀─ EVALSHA breaker 'read' ────│                            │
   │                   │                            │                              │── POST signed (10 s max) ─▶│
   │                   │                            │                              │◀── 200 / 4xx / 5xx / 429 ──│
   │                   │                            │◀─ EVALSHA success|failure ───│                            │
   │                   │                 Postgres ◀──── INSERT attempt, UPDATE status                          │
```

Three ideas carry the whole design:

- **Two hot paths.** The API is the *short* one (milliseconds, local work only). The worker is the *long* one (network, timeouts, hours of retries). They never call each other; they share Postgres (durable state) and Redis (queue, breaker, idempotency).
- **Decide, then act.** Pure functions in `packages/core` decide (classify a response, compute a delay, apply a breaker transition, compare payload hashes). The apps do the I/O. That split is why most of the logic is unit-testable without containers.
- **At-least-once.** Every failure path re-runs work rather than risk losing it. Duplicates are possible; losses should not be (and the README lists the two places where they still are).

---

## 2. Reading order

Each stop: **why now**, **what to look for**, **the lines that matter**, a **check question**.

### Layer 0: vocabulary

#### 1. `packages/db/src/schema.ts`
- **Why now:** every other file reads or writes these four tables. Learn the nouns first.
- **Look for:** which FKs cascade and which don't; the three indexes and the query each one serves; `status` as `text` + `CHECK`.
- **Lines that matter:**
  ```ts
  statusIdx: index('events_endpoint_status_idx').on(t.endpointId, t.status, t.createdAt),
  uniq: uniqueIndex('delivery_attempts_event_attempt_uniq').on(t.eventId, t.attemptNumber),
  ```
- **Check:** why is there no index on `delivery_attempts.event_id` alone?
  <details><summary>Answer</summary>The unique index starts with <code>event_id</code>, so a B-tree on <code>(event_id, attempt_number)</code> already serves "all attempts of event X" and <code>MAX(attempt_number) WHERE event_id = X</code>. A second index would only cost writes.</details>

#### 2. `packages/core/src/types.ts` and `ids.ts`
- **Why now:** the API's input contract and the id format you'll see in every log.
- **Look for:** the 1 MB payload limit measured on serialized UTF-8 bytes; `https://` only for endpoint URLs; ULID after the prefix.
- **Lines that matter:**
  ```ts
  (v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1_048_576,
  .refine((u) => u.startsWith('https://'), 'must be https'),
  ```
- **Check:** why ULID instead of UUIDv4 for event ids?
  <details><summary>Answer</summary>ULIDs sort by creation time (48-bit timestamp first), so ids are ordered in logs and B-tree inserts land near the right edge of the index instead of at random pages. UUIDv4 is random everywhere.</details>

### Layer 1: the pure core (no I/O)

#### 3. `packages/core/src/crypto/hmac.ts`
- **Why now:** it defines what a receiver can verify; everything the worker sends is shaped by it.
- **Look for:** what is signed (`id.timestamp.body`), the `v1,` scheme prefix, the constant-time compare, and what is *not* checked (timestamp freshness).
- **Lines that matter:**
  ```ts
  const signedString = `${params.id}.${params.timestamp}.${params.body}`
  return timingSafeEqual(providedBuf, expectedBuf)
  ```
- **Check:** an attacker captures one valid delivery. What stops them from replaying it a day later, and whose job is it?
  <details><summary>Answer</summary>The timestamp is inside the signed string, so it can't be changed without breaking the MAC. The receiver must reject timestamps too far from its clock (Standard Webhooks suggests minutes). <code>verifyWebhookSignature</code> doesn't do that check; it's the receiver's job, and dedupe on <code>webhook-id</code> covers the rest.</details>

#### 4. `packages/core/src/crypto/encryption.ts` and `password.ts`
- **Why now:** two different secrets, two different tools. Understand why.
- **Look for:** buffer layout `iv(12) | tag(16) | ciphertext`; a random IV per encryption; argon2id parameters.
- **Lines that matter:**
  ```ts
  const iv = randomBytes(IV_BYTES) // ⭐ RANDOM IV every time (never reused)
  decipher.setAuthTag(tag) // provide the tag → GCM will verify integrity
  ```
- **Check:** why are API keys hashed but endpoint secrets encrypted?
  <details><summary>Answer</summary>We only need to <em>verify</em> an API key (hash, compare), but the worker needs the endpoint secret in clear to compute the HMAC. You can't compute an HMAC from a hash.</details>

#### 5. `packages/core/src/idempotency.ts`
- **Why now:** the decision half of idempotency. The Redis half comes at stop 12.
- **Look for:** three outcomes, and that the decision is about the *payload hash*, not just the key.
- **Lines that matter:**
  ```ts
  if (params.stored.payloadSha256 === params.incomingHash) {
    return { kind: 'existing', eventId: params.stored.eventId }
  ```
- **Check:** why not just return the existing event whenever the key matches?
  <details><summary>Answer</summary>A key reused with a different body is a client bug. Silently returning the old event would hide data loss on their side; <code>422</code> surfaces it.</details>

#### 6. `packages/core/src/retry/classify.ts`, `backoff.ts`, `retry-after.ts`
- **Why now:** these three functions are the whole retry policy.
- **Look for:** 3xx counts as success; 429 is its own class; the schedule is "delay *before* attempt N"; jitter is multiplicative; an out-of-range `Retry-After` returns `null` (ignored, not clamped).
- **Lines that matter:**
  ```ts
  export const RETRY_SCHEDULE_MS = [0, 1_000, 10_000, 60_000, 600_000, 3_600_000, 21_600_000]
  const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * rng()
  ```
- **Check:** what delay does `backoffMs(4)` return, and within which bounds?
  <details><summary>Answer</summary>Base 60 s (index 3), times a factor in [0.8, 1.2): between 48 s and 72 s.</details>

#### 7. `packages/core/src/breaker/fsm.ts`
- **Why now:** the breaker rules in readable TypeScript before you read them in Lua.
- **Look for:** what each state does with `success`, `failure`, `read`; the doubling and its cap.
- **Lines that matter:**
  ```ts
  if (next >= FAIL_THRESHOLD) {   // 5
  const doubled = Math.min(state.openDurationMs * 2, MAX_OPEN_MS)
  ```
- **Check:** after three failed probes in a row, how long is the cooldown?
  <details><summary>Answer</summary>Opens at 30 s; probe 1 fails → 60 s; probe 2 fails → 120 s; probe 3 fails → 240 s. Cap is 30 min.</details>
- **Note:** this is the model, not what runs. Stop 8 is what runs, and differs on two details (see its check question).

### Layer 2: Redis and the queue

#### 8. `packages/queue/src/lua/record_outcome.lua`
- **Why now:** the most interesting file of the project. Atomicity is the point.
- **Look for:** state loaded, lazily moved `open → half_open`, transitioned, written back with a TTL, returned. One script call = one atomic step.
- **Lines that matter:**
  ```lua
  if state.state == 'open' and state.openedAt and (state.openedAt + state.openDurationMs) <= now then
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
  ```
- **Check:** find two behaviors where this script and `fsm.ts` differ.
  <details><summary>Answer</summary>(1) The lazy <code>open → half_open</code> check runs for every event in Lua, only for <code>read</code> in <code>fsm.ts</code>. (2) The boundary: Lua uses <code>&lt;= now</code>, <code>fsm.ts</code> uses <code>nowMs &gt; expiresAt</code>. The unit tests cover the model, <code>packages/queue/tests/breaker.test.ts</code> covers the script.</details>

#### 9. `packages/queue/src/breaker.ts`
- **Why now:** how Node calls the script, and the failure mode of script caching.
- **Look for:** `SCRIPT LOAD` once, `EVALSHA` after, reload on `NOSCRIPT`; the ARGV order contract; the test-only override.
- **Lines that matter:**
  ```ts
  raw = (await redis.evalsha(sha, 1, `breaker:${endpointId}`, ...args)) as string
  if (err instanceof Error && err.message.includes('NOSCRIPT')) {
  ```
- **Check:** Redis restarts while the worker runs. What happens on the next breaker call?
  <details><summary>Answer</summary><code>EVALSHA</code> fails with <code>NOSCRIPT</code> (the script cache is in memory, not persisted). The catch resets the cached SHA, reloads the script and retries once.</details>

#### 10. `packages/queue/src/delivery-queue.ts` and `redis.ts`
- **Why now:** the BullMQ contract the worker relies on.
- **Look for:** `attempts: 7`, `backoff: { type: 'custom' }`, bounded `removeOnComplete/removeOnFail`, `maxRetriesPerRequest: null`.
- **Lines that matter:**
  ```ts
  const nextAttempt = attemptsMade + 1
  return backoffMs(nextAttempt) // our exponential delay + jitter
  ```
- **Check:** attempt 1 just failed with a 500. Which value does BullMQ pass to `backoffStrategy`, and what delay comes back?
  <details><summary>Answer</summary>BullMQ passes the number of attempts made, counting the one that just failed: 1. <code>nextAttempt = 2</code>, so <code>backoffMs(2)</code> = 1 s ± 20 %. (In bullmq 5.x, <code>job.shouldRetryJob</code> calls the strategy with <code>attemptsMade + 1</code> before incrementing.)</details>

### Layer 3: the API (short hot path)

#### 11. `apps/api/src/server.ts`, `plugins/*.ts`
- **Why now:** how dependencies reach the routes, and why tests can inject containers.
- **Look for:** `buildApp(opts)` with optional `db`, `redis`, `masterKey`; plugins decorating `app`; `onClose` in the queue plugin; the auth cache in `auth.ts`.
- **Lines that matter:**
  ```ts
  await app.register(dbPlugin, opts.db ? { db: opts.db } : {})
  if (hit && hit.expiresAt > now) {   // auth.ts: skip argon2 for a known token
  ```
- **Check:** why does the auth plugin cache by SHA-256 of the token instead of by the token itself?
  <details><summary>Answer</summary>So the plaintext API key never sits in a long-lived data structure (heap dumps, debug output). The SHA-256 is cheap to compute and enough as a lookup key; the expensive argon2 verify only runs on a miss.</details>

#### 12. `apps/api/src/routes/events.ts` → `services/ingestion.ts`
- **Why now:** the full short hot path, and the first race condition of the project.
- **Look for:** the order *claim key → insert → enqueue*, and what happens if a step fails in between. `jobId: eventId`.
- **Lines that matter:**
  ```ts
  const setOk = await opts.redis.set(idemKey, idemValue, 'EX', IDEM_TTL_SEC, 'NX')
  await opts.queue.add('deliver', { eventId }, { jobId: eventId })
  ```
- **Check:** Postgres is down for 2 s. A client posts with key `k1`, gets a 500, retries with `k1` after Postgres is back. What does it get?
  <details><summary>Answer</summary><code>200</code> with an event id that doesn't exist: the Redis key was claimed before the failed insert and lives 24 h. This is the gap documented in the code and the spec. Fixes: delete the key on insert failure (best-effort), or move idempotency into Postgres in the same transaction as the insert.</details>

#### 13. `apps/api/src/services/replay.ts`
- **Why now:** a small file that shows why `jobId` matters.
- **Look for:** the ownership join, the `409` on pending, the replay `jobId`.
- **Lines that matter:**
  ```ts
  if (row.event.status === 'pending') return { kind: 'conflict_pending' }
  { jobId: `${opts.eventId}-replay-${Date.now()}` },
  ```
- **Check:** what would happen with `jobId: opts.eventId`?
  <details><summary>Answer</summary>BullMQ keeps the original job (last 1,000 completed / 5,000 failed). <code>add()</code> with an existing <code>jobId</code> is a no-op, so the event would be set back to <code>pending</code> and never delivered.</details>

### Layer 4: the worker (long hot path)

#### 14. `apps/worker/src/http-client.ts`
- **Why now:** the one place that talks to the outside world.
- **Look for:** both timeouts, the response excerpt, `Retry-After` as string or array, errors mapped to outcomes. It decides nothing.
- **Lines that matter:**
  ```ts
  bodyTimeout: p.timeoutMs,
  headersTimeout: p.timeoutMs,
  ```
- **Check:** an endpoint answers headers in 1 s, then streams its body for 30 s. Timeout?
  <details><summary>Answer</summary>Yes, <code>bodyTimeout</code> is an inactivity timeout between body chunks in undici, not a total budget. A body trickling one chunk every 9 s would never trip it. A total deadline would need an <code>AbortSignal.timeout()</code>.</details>

#### 15. `apps/worker/src/deliver.ts`
- **Why now:** the heart. One attempt, end to end.
- **Look for:** breaker read first; probe lock in half-open; fresh timestamp; attempt row before the decision; which outcome records breaker success vs failure.
- **Lines that matter:**
  ```ts
  const acquired = await ctx.redis.set(lockKey, '1', 'EX', 5, 'NX') // SET NX = atomic lock
  if (result.outcome.kind === 'http_4xx') {
    await recordOutcome(ctx.redis, evRow.endpoint.id, 'success', Date.now())
  ```
- **Check:** list every Postgres write of one successful attempt, and say how many commits that is.
  <details><summary>Answer</summary>One <code>SELECT MAX(attempt_number)</code> (read), one <code>INSERT</code> into <code>delivery_attempts</code>, one <code>UPDATE events</code>. No explicit transaction, so each write autocommits: 2 commits, each one a WAL flush. See <code>docs/next-ingest.md</code> for what a commit costs on real hardware.</details>

#### 16. `apps/worker/src/worker.ts`
- **Why now:** where a decision becomes BullMQ control flow.
- **Look for:** four exits (return, `DelayedError`, `UnrecoverableError`, plain `Error`); the `failed` handler and its guard; the missing `SIGTERM` handler.
- **Lines that matter:**
  ```ts
  await job.moveToDelayed(Date.now() + result.remainingMs, token)
  throw new DelayedError(`breaker_open:retry_in_${result.remainingMs}ms`)
  ```
- **Check:** why does the `failed` handler check `attemptsMade >= maxAttempts` instead of marking the event dead directly?
  <details><summary>Answer</summary>The worker emits <code>failed</code> after every failed attempt, including ones BullMQ will retry. Without the check, the first 500 would mark the event dead while it is still being retried.</details>

### Layer 5: tests, chaos, infra

#### 17. `tests/integration/vitest-setup.ts`, `breaker.test.ts`, `dlq.test.ts`, `packages/test-helpers/src/app-fixture.ts`
- **Look for:** how time is compressed (schedule `[0, 50, 100, 200, 400, 800, 1600]` ms, cooldown 1 s); the `waitFor` on Redis state instead of on received requests; the close order in the fixture.
- **Check:** why does `breaker.test.ts` wait for the Redis key to say `open` rather than for 5 received requests?
  <details><summary>Answer</summary><code>recordOutcome('failure')</code> runs after the HTTP response is received. Five requests seen by the fake endpoint doesn't mean five failures recorded yet; pushing the 6th event at that point would race the breaker.</details>

#### 18. `scripts/chaos/*`, `apps/demo/src/scenario.ts`, `run-manager.ts`
- **Look for:** phases relative to run start; the deterministic flaky pattern in the demo (every third request fails, the first succeeds so the probe always lands); one run at a time; SSE broadcast.
- **Check:** why is the flaky phase deterministic in the public demo but random in `pnpm demo:chaos`?
  <details><summary>Answer</summary>The public page must tell the same story on every click: a random probe failure would double the cooldown and sometimes leave the backlog undrained at the end. The CLI run is an experiment, randomness is fine there.</details>

#### 19. `docker-compose.prod.yml`, `deploy/deploy.sh`, `.github/workflows/ci.yml`
- **Look for:** Redis `--appendonly yes --maxmemory 128mb --maxmemory-policy noeviction`; `migrate` as a one-shot dependency; the forced-command deploy key; deploy concurrency group.
- **Check:** why `noeviction` rather than `allkeys-lru` for this Redis?
  <details><summary>Answer</summary>Redis holds queued jobs and breaker state. LRU eviction would silently drop jobs (lost events). With <code>noeviction</code>, a full Redis refuses writes: loud failure, nothing lost.</details>

---

## 3. Concepts in depth

### 3.1 The event loop: what runs on it, what doesn't

Node runs your JavaScript on one thread. Anything synchronous blocks every other request and every other job in the process.

| Code | Where it runs | Cost |
|---|---|---|
| `JSON.stringify(payload)` in the Zod refine, then again in `ingestion.ts` for the hash | event loop, synchronous | proportional to payload size; up to 1 MB, serialized more than once per request |
| `sha256Hex`, `createHmac`, AES-GCM decrypt | event loop, synchronous | microseconds for small inputs, linear in size |
| argon2 verify (`@node-rs/argon2`) | native async task, off the JS thread | tens of ms, but doesn't block the loop |
| `undici.request`, Postgres, Redis | sockets, async | waiting costs nothing on the loop |
| `readFileSync` of the Lua script | event loop, once at module load | irrelevant at startup |

Consequences to be able to explain:
- `concurrency: 10` works on one thread because a delivery is mostly *waiting* (HTTP, Postgres, Redis). Ten jobs interleave their waits.
- A burst of 1 MB payloads makes the API CPU-bound on serialization and hashing, not I/O-bound. More API processes (or `node:cluster`) would scale that; more concurrency wouldn't.
- The auth cache exists because argon2 is deliberately slow: even off the loop, a scan of N clients × tens of ms per request is too much.
- The `void db.update(...).catch(...)` in `worker.on('failed')`: event listeners are synchronous; the promise runs detached, so it needs its own `catch` or a rejection would be unhandled.

This is exactly the comparison the follow-up project measures against Go's scheduler (see [`docs/next-ingest.md`](docs/next-ingest.md)).

### 3.2 Redis atomicity: `SET NX`, Lua, and what is *not* atomic

- **Single command = atomic.** `SET key value EX ttl NX` claims a key and sets its expiry in one step: used for idempotency and the probe lock. The older `SETNX` + `EXPIRE` pair could leave a key without TTL if the process died in between.
- **Script = atomic.** Redis executes a Lua script to completion before serving any other command. That turns "read state, decide, write state" into one indivisible step. The price: a slow script blocks all of Redis, so it must stay tiny (this one does a `GET`, some arithmetic, a `SET`).
- **Not atomic: anything spanning two calls.** Examples in this code: `INCR` then `EXPIRE` on `skip_count` (harmless: worst case a counter without TTL); idempotency `SET NX` then Postgres `INSERT` (the documented gap); `MAX()` then `INSERT` for `attempt_number` (protected by one-job-per-event and the unique index).
- **Keys via `KEYS[]`.** The script receives its key as `KEYS[1]`, not as a string built inside Lua. In Redis Cluster, that is how Redis knows which node must run the script.
- **Time passed in.** The script uses the caller's `now`, so worker clocks must roughly agree. It also makes the script deterministic, which is how `breaker.test.ts` can simulate "31 s later" instantly.

### 3.3 BullMQ retry semantics

| You do | BullMQ does | Attempt consumed? |
|---|---|---|
| return normally | job `completed` | yes (the successful one) |
| `throw new Error()` | if `attemptsMade + 1 < attempts`: delay = `backoffStrategy(...)`, job → delayed; else job → failed | yes |
| `throw new UnrecoverableError()` | job → failed now, remaining attempts ignored | yes |
| `job.moveToDelayed(ts, token)` then `throw new DelayedError()` | job stays delayed until `ts`; the error only means "don't treat this as a failure" | **no** |
| process dies mid-job | the job lock expires (`lockDuration`, 30 s by default); the stalled-job check (every 30 s) moves it back to wait and it runs again. Past `maxStalledCount` (default 1) it is failed instead | no attempt counted, but the work runs twice. A job failed for stalling twice leaves its event `pending`, since the `failed` handler only acts after 7 attempts |

Details worth knowing:
- `token` is the job lock token. `moveToDelayed` needs it because only the lock holder may move an active job.
- `jobId` deduplicates: adding a job whose id already exists in the queue (any state still kept in Redis) is a no-op. That is why ingestion uses `jobId = eventId` and replay uses a fresh one.
- `worker.on('failed')` fires on every failure, retried or not. Final failure = `attemptsMade >= attempts`.
- The worker's `backoffStrategy` is never consulted for `DelayedError` paths: the breaker and `Retry-After` set their own delay.

### 3.4 Postgres: transactions, idempotency and write cost

- **Autocommit.** postgres-js (behind Drizzle) runs every statement in its own transaction unless you use `db.transaction()`. This code never does. Each `INSERT`/`UPDATE` is a commit, and with the default `synchronous_commit = on`, a commit waits for the WAL to reach disk (`fsync`/`fdatasync`). That flush, not the row size, is what bounds one-row-per-transaction throughput: see the pgbench numbers in [`docs/next-ingest.md`](docs/next-ingest.md).
- **Where a transaction would help, and where it can't.** Attempt insert + event update could share one transaction (both Postgres). Event insert + BullMQ enqueue can't: two systems. The standard answer is a transactional **outbox**: insert the event *and* an outbox row in one transaction, and let a relay enqueue from the outbox.
- **Idempotency in the database.** The strongest version is a `UNIQUE (client_id, idempotency_key)` column written in the same transaction as the event, with `INSERT … ON CONFLICT DO NOTHING RETURNING`. Then there is no window where Redis and Postgres disagree; you need a cleanup job for the 24 h expiry.
- **Conditional update as compare-and-set.** In the `failed` handler: `UPDATE events SET status='dead' WHERE id = $1 AND status = 'pending'`. If a replay or a late success already changed the row, the update matches zero rows instead of overwriting.
- **Constraints as the last line of defense.** `CHECK` on status, unique `(event_id, attempt_number)`, FKs. Application logic should make them never fire; they make bugs fail loudly instead of corrupting data.
- **JSONB.** Stored parsed and normalized (key order, whitespace), which is why the worker re-serializes the payload and signs that string.

### 3.5 Signing and secrets in one picture

```
create endpoint:  secret = whsec_<24 random bytes, base64url>  →  shown once to the client
                  stored  = AES-256-GCM(masterKey, secret) = iv | tag | ciphertext  (bytea)
deliver:          secret  = decrypt(stored, masterKey)          (tamper → throws)
                  sig     = "v1," + base64(HMAC-SHA256(secret, id + "." + ts + "." + body))
receiver:         recompute, timingSafeEqual, check |now - ts| is small, dedupe on webhook-id
```

---

## 4. The life of one event (recite it)

1. `POST /events` with a Bearer key and an `Idempotency-Key`. Auth (argon2 or cache), Zod, tenant check.
2. `SET idem:… NX EX 86400` → fresh. `INSERT event (pending)`. `queue.add(jobId = eventId)`. `202` in a few ms.
3. A worker slot picks the job. Breaker `read` → `closed`.
4. Decrypt the secret, sign with a fresh timestamp, POST (10 s timeouts).
5. `503` → attempt row #1, breaker `failure` (count 1), throw `Error` → BullMQ retries in ~1 s.
6. Four more events fail the same way → count reaches 5 → breaker `open`, cooldown 30 s.
7. Next jobs read `open` → `moveToDelayed(remaining)` + `DelayedError`: no attempt consumed, no attempt row, `skip_count` + 1.
8. 30 s later, the first script call flips it to `half_open`. One worker wins the probe lock and delivers; the others come back in 1 s.
9. Probe gets `200` → breaker `closed`, cooldown back to 30 s, event `delivered`. The backlog drains.
   Probe gets `500` → `open` again for 60 s.
10. A `429` with `Retry-After: 30` → delayed exactly 30 s, no attempt consumed. A `422` → `dead` immediately, breaker records *success*.
11. Seven failed attempts → `failed` handler marks the event `dead`.
12. `GET /events/:id` shows status and every attempt. `POST /events/:id/replay` sets it back to `pending` with a fresh job.

---

## 5. Interview questions (with model answers)

**1. Walk me through the architecture.**
Two processes from one image. The API validates, dedupes, stores the event, enqueues a job and answers `202`. The worker consumes jobs, checks a per-endpoint breaker in Redis, signs and POSTs, logs every attempt in Postgres and retries on a schedule. They share Postgres for durable state and Redis for the queue, breaker and idempotency. Decoupling keeps API latency independent of customers' endpoints.

**2. What delivery guarantee do you offer?**
At-least-once. If a worker dies after the endpoint answered `200` but before the status update, the job runs again. I don't promise exactly-once because it's impossible across a network without the receiver's cooperation; instead the `webhook-id` header is stable across retries so receivers dedupe.

**3. How does idempotency work, and where can it fail?**
`SET idem:{client}:{key} {eventId, payloadHash} NX EX 86400`. First caller wins and creates the event; a repeat with the same hash gets the same id; a different hash gets `422`. Weak spot: the key is claimed before the Postgres insert, so if the insert fails, retries get an id that doesn't exist for 24 h. I'd fix it by moving the key into Postgres with a unique constraint in the same transaction.

**4. How does the breaker stay correct with many workers?**
Its state lives in Redis and every transition is one Lua script: read, decide, write, atomically. Redis runs scripts one at a time, so no two workers can interleave a read-modify-write. In half-open, a `SET NX EX 5` lock lets a single probe through.

**5. Why not keep breaker state in the worker's memory?**
Each process would have its own view: one worker would keep hammering an endpoint another one has already given up on, and a restart would forget everything. The breaker protects the *endpoint*, so its state must be shared like the endpoint is.

**6. Why does a 4xx not trip the breaker?**
Because the endpoint is alive and answering. The breaker detects dead or overloaded endpoints. A `422` is about the payload: that event goes `dead`, the endpoint stays healthy for the others. A `429` is different: it means "slow down", so it counts as a failure.

**7. How do you avoid wasting retries while an endpoint is down?**
When the breaker is open, the worker moves the job to delayed until the cooldown ends and throws `DelayedError`. BullMQ doesn't count it as a failed attempt, and no attempt row is written. The seven attempts are reserved for real calls.

**8. Why jitter?**
Events that failed together would otherwise retry together, in synchronized waves that can knock a recovering endpoint back down. ±20 % spreads them out.

**9. What's in the signature and why the timestamp?**
HMAC-SHA256 of `id.timestamp.body` with a per-endpoint secret. The id lets the receiver dedupe, the timestamp lets them reject old replays, the body proves integrity. The timestamp is the attempt's, otherwise a correct receiver would reject late retries.

**10. How are secrets protected?**
Endpoint secrets are AES-256-GCM encrypted at rest with a master key that only lives in the environment; GCM's tag detects tampering. API keys are argon2id hashes. Signatures are compared in constant time.

**11. What happens on deploy with jobs in flight?**
Today, the worker has no `SIGTERM` handler, so in-flight jobs die; their lock expires and BullMQ re-runs them, so some events are delivered twice. That's within at-least-once but noisy. The fix is `process.on('SIGTERM', () => worker.close())`, which waits for running jobs.

**12. What would break first at 100× traffic?**
The Postgres write path: one autocommit insert per event and two writes per attempt, each paying a WAL flush, with tables that never shrink. Then a single queue shared by all tenants, where slow endpoints occupy worker slots. I'd batch writes, partition `events` by time with a retention policy, and add per-endpoint concurrency limits.

**13. How do you test time-dependent behavior without waiting hours?**
The pure parts take time or randomness as parameters (`nowMs`, `rng`). For integration tests, test-only hooks shrink the retry schedule to milliseconds and the breaker cooldown to 1 s, and the real API and worker run against real Postgres and Redis containers.

**14. Why is `jobId = eventId` important?**
It makes enqueueing idempotent: a second `add()` for the same event is a no-op, so the same event can't have two concurrent jobs racing on `attempt_number`. Replay uses a different id on purpose, because the old job may still be kept.

**15. Is ordering guaranteed?**
No. Ten concurrent jobs per worker, independent retry timers and jitter. If a customer needs order, they should use the event's timestamp or a sequence number in the payload; enforcing order per endpoint would mean one job at a time per endpoint, with head-of-line blocking.

---

## 6. Exercises

Each one: change something, predict the outcome *before* running, then verify. Revert afterwards (`git checkout -- <file>`).

1. **Breaker threshold.** In `packages/core/src/breaker/fsm.ts`, set `FAIL_THRESHOLD = 3`. Predict which tests in `packages/core/tests/breaker/fsm.test.ts` fail and why. Verify: `pnpm --filter @vitrine/core test`. Then notice that `tests/integration/breaker.test.ts` would still pass: why? (The Lua script takes its threshold from `breaker.ts`, not from `fsm.ts`.)
2. **Lua boundary.** In `record_outcome.lua`, change `<= now` to `< now`. Predict whether `packages/queue/tests/breaker.test.ts` notices. (It reads at `openedAt + 31 s`, so no: the boundary is untested. Write the test that would catch it: read at exactly `openedAt + 30 000`.)
3. **Lose the `DelayedError`.** In `worker.ts`, replace the breaker-skip `throw new DelayedError(...)` with `throw new Error(...)` (keep `moveToDelayed`). Predict what happens to attempts while the breaker is open. Verify with `pnpm test:integration -- breaker` and by reading the BullMQ source in `node_modules/bullmq/dist/esm/classes/worker.js` (`handleFailed`).
4. **4xx as failure.** In `deliver.ts`, record `'failure'` instead of `'success'` for `http_4xx`. Predict the effect on the public demo, where 1 event in 25 gets a `422`. (Poison events now count toward the 5 consecutive failures; mostly harmless since successes reset the count, but a burst of bad payloads would open the breaker for every good event of that tenant.)
5. **Replay jobId.** In `replay.ts`, use `jobId: opts.eventId`. Predict which test in `tests/integration/replay.test.ts` fails and why.
6. **Attempt numbering race.** Drop the unique index from `schema.ts` in your head, then imagine two jobs for the same event. Write down the interleaving that produces two rows with `attempt_number = 2`. Which line in `ingestion.ts` prevents two jobs in the first place?
7. **Jitter bounds.** In `packages/core/tests/retry/backoff.test.ts`, add a test asserting `backoffMs(7, () => 0.999)` is below `21_600_000 * 1.2`. Predict the result before running.
8. **Close the idempotency gap.** Sketch (on paper, not in the repo) `ingestEvent` with idempotency in Postgres: schema change, the `INSERT … ON CONFLICT` statement, how you detect "existing" vs "conflict", and how expiry works. Compare the number of round trips with today's version.
9. **Graceful shutdown.** Write the 6 lines that would make the worker stop cleanly on `SIGTERM`. What should happen to a job that is half-way through a 10 s HTTP timeout?

---

## 7. Known gaps (be the first to say them)

In an interview, naming your own system's weak spots, with the fix, beats waiting for the question. Each one has a comment at the exact line:

| Gap | Where | Fix |
|---|---|---|
| Idempotency key claimed before the insert | `ingestion.ts` | idempotency in Postgres, same transaction |
| Insert and enqueue not atomic | `ingestion.ts` | transactional outbox or pending-row sweeper |
| No graceful shutdown | `worker.ts`, `server.ts` | `SIGTERM` → `worker.close()` / `app.close()` |
| Probe lock 5 s < HTTP timeout 10 s | `deliver.ts` | lock TTL > timeout, or release after the probe |
| `429` + `Retry-After` never consumes an attempt | `worker.ts` | count throttles, or cap total delay per event |
| Lua and `fsm.ts` differ on two details | `record_outcome.lua` | align them, test the boundary |
| `bodyTimeout` is an inactivity timeout | `http-client.ts` | add a total deadline (`AbortSignal.timeout`) |

---

## 8. Glossary

- **Hot path**: the latency-critical path of a request.
- **At-least-once**: every event is delivered one or more times; duplicates possible, loss not intended.
- **Idempotency key**: client-chosen id that makes a retried request safe to repeat.
- **Circuit breaker**: per-dependency state machine that stops calls to a failing dependency, then probes it.
- **Thundering herd**: many waiters waking at the same moment and stampeding a resource (fixed here by jitter and the probe lock).
- **DLQ / dead letter**: here, `status = 'dead'`: given up after a permanent error or 7 attempts.
- **WAL**: Postgres' write-ahead log; a commit is durable once its WAL record is on disk.
- **Outbox**: writing "to publish" rows in the same DB transaction as the business change, then relaying them to the queue.

---

## 9. Next level

The follow-up project, **ingest**, takes this service's weakest scaling point (one autocommit insert per event) and measures it on dedicated hardware, then rewrites the ingestion service in Node and Go. French study notes, first pgbench results and what they mean for this code: [`docs/next-ingest.md`](docs/next-ingest.md).
