# Webhook Delivery Hot Path — Chaos Demo + Fly Deploy + CI Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete milestones M5 (chaos demo with narrative PNG) and M6 (Dockerfile + Fly.io + GitHub Actions CI/CD + final README) of the spec, starting from the fully working local Node/TS service produced by Plan 1.

**Architecture:** A standalone script `scripts/chaos/run.ts` that orchestrates an end-to-end demo (fake endpoint scripted in 4 phases, push of 100 events, 1 Hz sampling, PNG generation via `chartjs-node-canvas`). A multi-stage Dockerfile to package the shared API+Worker image. A single Fly app with two `[processes]` (api, worker) sharing the image and secrets. A GitHub Actions workflow `ci.yml` for typecheck + lint + unit + integration, and a `deploy.yml` workflow for `flyctl deploy` on push to `main`.

**Tech Stack:** Node.js 22 LTS, pnpm 9, `chartjs-node-canvas` 4.x, Docker (multi-stage Alpine), Fly.io (`flyctl`), GitHub Actions (`ubuntu-latest`, hosted Docker).

**Plan 2 prerequisites**: Plan 1 fully executed, `pnpm test:integration` suite green locally, `pnpm dev` able to serve a POST /events that ends up `delivered`.

---

## Reference spec

`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`. Sections directly addressed by this plan:
- Section 1 — criterion "deployed on Fly.io, reachable via public URL" + "most recent chaos run PNG embedded".
- Section 7.3 — chaos demo (script, 4-phase scenario, PNG generation).
- Section 7.4 — CI (typecheck, lint, unit, integration).
- Section 9 — deployment (Fly.io + Neon + Upstash, multi-stage Dockerfile, secrets, release_command).
- Appendix — `chartjs-node-canvas` or alternative.

Any inconsistency between this plan and the spec is resolved in favor of the spec.

---

## Target file structure (delta from Plan 1 state)

```
vitrine/
├── scripts/
│   └── chaos/
│       ├── run.ts                  # entry — pnpm demo:chaos
│       ├── fake-endpoint.ts        # Fastify server scripted in 4 phases
│       ├── collector.ts            # 1 Hz sampling (events stats + breaker + latency)
│       ├── render-png.ts           # chartjs-node-canvas → PNG
│       └── orchestrator.ts         # spin compose, seed, run, teardown
├── docs/
│   └── chaos-runs/
│       ├── .gitkeep
│       └── 2026-05-XX-HH-MM.png    # generated on first run, then committed
├── docker/
│   └── Dockerfile                  # multi-stage, shared API+Worker image
├── docker-compose.demo.yml         # Postgres + Redis + API + Worker (built image)
├── .dockerignore
├── fly.toml                        # single app, processes api + worker
├── .github/
│   └── workflows/
│       ├── ci.yml                  # typecheck + lint + unit + integration
│       └── deploy.yml              # flyctl deploy on push main
├── README.md                       # UPDATE: CI badge, Fly URL, PNG embed
└── package.json                    # UPDATE: demo:chaos script, chartjs-node-canvas deps
```

The other directories (`apps/`, `packages/`, `tests/`) stay unchanged except for documented one-off changes (e.g. adding a `start` script to each app).

---

## Decisions locked before execution

| Topic | Chosen option | Reason |
|---|---|---|
| PNG chart lib | `chartjs-node-canvas` 4.x | Spec section 7.3, mainstream, deterministic rendering |
| Fly topology | 1 app, 2 process groups (`api`, `worker`) | Simplifies secrets and CI/CD; allowed by spec |
| Image build | No tsup, keep tsx at runtime | Avoids refactoring the packages build, image stays light, start speed negligible for a showcase |
| Prod migrations | `pnpm --filter @vitrine/db push --force` as Fly `release_command` | Consistent with Testcontainers, no `__drizzle_migrations` journal |
| Chaos infra | `docker-compose.demo.yml` that builds the image (API+Worker) + Postgres + Redis | Spec section 7.3, isolates the run from the dev environment |
| Demo Redis persistence | `tmpfs` in the compose | Guaranteed reset on every run |
| Demo Postgres | `tmpfs` as well | Same |
| Chaos sampling | 1 Hz (1s tick) | Spec section 7.3 |
| Push events | 100 over 5 s = 20 events/s, throttled via a Promise queue with concurrency 10 | Avoids saturating the local port |
| Scripted phases | 0-10 s 200 OK; 10-40 s 500; 40-80 s 50/50; 80-110 s 200 OK | Spec section 7.3; total duration 110 s + 30 s drain |
| Drain window | 30 s after end of phase 4 | Covers the 1 s + 10 s retries without being too long |

---

## Phase A — Dependencies and directory tree setup

### Task A.1 — Add chaos dependencies to the workspace root

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Modify: `pnpm-lock.yaml` (auto)

- [ ] **Step 1: Add `chartjs-node-canvas` and `chart.js` (peer) to the root devDependencies**

Edit `package.json`. Under `devDependencies`, add `"chartjs-node-canvas": "^4.1.6"` and `"chart.js": "^4.4.0"`. Also add `"undici": "^6.20.0"` if not already present at the root (used by the chaos collector to call the API). Add `"ioredis": "^5.4.0"` to the root devDeps if missing (the chaos collector reads `breaker:*` directly). Add `"@vitrine/db": "workspace:*"` to the root devDeps if not already present.

Under `scripts`, add:

```json
"demo:chaos": "tsx scripts/chaos/run.ts"
```

Expected final state of the `scripts` section:

```json
"scripts": {
  "build": "pnpm -r build",
  "typecheck": "pnpm -r typecheck",
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "test": "pnpm test:unit && pnpm test:integration",
  "test:unit": "pnpm -r --filter './packages/**' test",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "dev": "concurrently -n api,worker -c blue,magenta 'pnpm --filter @vitrine/api dev' 'pnpm --filter @vitrine/worker dev'",
  "db:generate": "pnpm --filter @vitrine/db generate",
  "db:push": "pnpm --filter @vitrine/db push",
  "cli:create-client": "tsx scripts/cli/create-client.ts",
  "demo:chaos": "tsx scripts/chaos/run.ts"
}
```

- [ ] **Step 2: Install**

Run:

```bash
pnpm install
```

Expected: no error, `pnpm-lock.yaml` updated, `node_modules/chartjs-node-canvas` present.

- [ ] **Step 3: Check that `chartjs-node-canvas` loads correctly on this machine**

Run:

```bash
node --input-type=module -e "import('chartjs-node-canvas').then(m => console.log(typeof m.ChartJSNodeCanvas))"
```

Expected output: `function`.

If the import fails with a native error (cairo, pango), `node-canvas` failed to bind. On macOS: `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman`, then `pnpm rebuild canvas`. Document the native dependency in the README if needed.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add chartjs-node-canvas and chaos script entry"
```

---

### Task A.2 — Create the empty chaos directory tree + .gitkeep

**Files:**
- Create: `scripts/chaos/.gitkeep` (placeholder, will be removed in A.3+)
- Create: `docs/chaos-runs/.gitkeep`

- [ ] **Step 1: Create the directories**

```bash
mkdir -p scripts/chaos docs/chaos-runs
touch scripts/chaos/.gitkeep docs/chaos-runs/.gitkeep
```

- [ ] **Step 2: Verify**

```bash
ls scripts/chaos docs/chaos-runs
```

Expected: `.gitkeep` in both.

- [ ] **Step 3: Commit**

```bash
git add scripts/chaos/.gitkeep docs/chaos-runs/.gitkeep
git commit -m "chore: scaffold scripts/chaos and docs/chaos-runs directories"
```

---

## Phase B — Chaos demo: scripted fake endpoint

### Task B.1 — Implement `scripts/chaos/fake-endpoint.ts`

The fake endpoint reuses the same idea as `packages/test-helpers/src/fake-endpoint.ts`, but with a scenario driven by the time elapsed since startup. Deliberately not shared: the test fake endpoint is driven manually (`setResponse`), the chaos one follows an automatic curve. DRY does not apply — different boundaries.

**Files:**
- Create: `scripts/chaos/fake-endpoint.ts`
- Delete: `scripts/chaos/.gitkeep` (if present)

- [ ] **Step 1: Write the file**

```typescript
import Fastify, { type FastifyInstance } from 'fastify'

export interface PhaseConfig {
  /** ms since startTime at which this phase takes effect */
  startMs: number
  /** Endpoint behavior during this phase */
  behavior:
    | { kind: 'ok' }
    | { kind: 'fail'; statusCode: number }
    | { kind: 'mixed'; failRatio: number; failStatusCode: number }
}

export interface FakeEndpoint {
  url: string
  startedAt: number
  /** Cumulative number of requests received */
  totalReceived: () => number
  /** Active phase at a given instant (to annotate the PNG) */
  phaseAt: (ms: number) => number
  close: () => Promise<void>
}

export const CHAOS_PHASES: PhaseConfig[] = [
  { startMs: 0, behavior: { kind: 'ok' } },
  { startMs: 10_000, behavior: { kind: 'fail', statusCode: 500 } },
  { startMs: 40_000, behavior: { kind: 'mixed', failRatio: 0.5, failStatusCode: 500 } },
  { startMs: 80_000, behavior: { kind: 'ok' } }
]

function activeBehavior(elapsedMs: number, phases: PhaseConfig[]): PhaseConfig['behavior'] {
  let active = phases[0]!.behavior
  for (const phase of phases) {
    if (elapsedMs >= phase.startMs) active = phase.behavior
  }
  return active
}

export async function startChaosFakeEndpoint(opts: {
  phases?: PhaseConfig[]
  port?: number
}): Promise<FakeEndpoint> {
  const phases = opts.phases ?? CHAOS_PHASES
  const startedAt = Date.now()
  let totalReceived = 0

  const app: FastifyInstance = Fastify({ logger: false })

  app.post('/hook', async (req, reply) => {
    totalReceived++
    const elapsedMs = Date.now() - startedAt
    const behavior = activeBehavior(elapsedMs, phases)

    if (behavior.kind === 'fail') {
      return reply.code(behavior.statusCode).send({ error: 'fail' })
    }
    if (behavior.kind === 'mixed') {
      const fail = Math.random() < behavior.failRatio
      if (fail) return reply.code(behavior.failStatusCode).send({ error: 'fail' })
      return reply.code(200).send({ ok: true })
    }
    return reply.code(200).send({ ok: true })
  })

  // 0.0.0.0 so it is reachable from the worker container via host.docker.internal
  await app.listen({ host: '0.0.0.0', port: opts.port ?? 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')

  // The URL given to the API must point to the host from inside the Docker
  // worker. On Docker Desktop (mac/win), `host.docker.internal` resolves to the host.
  // On Linux, we use `--add-host=host.docker.internal:host-gateway` in the compose.
  const url = `http://host.docker.internal:${address.port}/hook`

  return {
    url,
    startedAt,
    totalReceived: () => totalReceived,
    phaseAt: (ms) => {
      let idx = 0
      for (let i = 0; i < phases.length; i++) {
        if (ms >= phases[i]!.startMs) idx = i
      }
      return idx + 1
    },
    close: async () => {
      await app.close()
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm tsc --noEmit scripts/chaos/fake-endpoint.ts
```

Expected: no error. If `Fastify`/`fastify` is not in the root deps, add `"fastify": "^5.0.0"` to `package.json` devDependencies then `pnpm install`.

- [ ] **Step 3: Isolated smoke test**

```bash
node --input-type=module -e "
import { startChaosFakeEndpoint, CHAOS_PHASES } from './scripts/chaos/fake-endpoint.ts'
const ep = await startChaosFakeEndpoint({ port: 0 })
console.log('url:', ep.url)
console.log('phase at 0ms:', ep.phaseAt(0))
console.log('phase at 15000ms:', ep.phaseAt(15000))
console.log('phase at 50000ms:', ep.phaseAt(50000))
console.log('phase at 90000ms:', ep.phaseAt(90000))
await ep.close()
" 2>&1 | tail -10
```

Note: Node 22 without tsx does not load `.ts` directly. Prefer:

```bash
pnpm tsx -e "
import { startChaosFakeEndpoint } from './scripts/chaos/fake-endpoint.ts'
const ep = await startChaosFakeEndpoint({ port: 0 })
console.log('url:', ep.url)
console.log('phase at 0ms:', ep.phaseAt(0))
console.log('phase at 15000ms:', ep.phaseAt(15000))
console.log('phase at 50000ms:', ep.phaseAt(50000))
console.log('phase at 90000ms:', ep.phaseAt(90000))
await ep.close()
"
```

Expected output (among the lines):

```
url: http://host.docker.internal:<port>/hook
phase at 0ms: 1
phase at 15000ms: 2
phase at 50000ms: 3
phase at 90000ms: 4
```

- [ ] **Step 4: Commit**

```bash
git rm scripts/chaos/.gitkeep 2>/dev/null || true
git add scripts/chaos/fake-endpoint.ts
git commit -m "feat(chaos): add scenarised fake endpoint with 4-phase schedule"
```

---

## Phase C — Chaos demo: compose stack and orchestration

### Task C.1 — Create `docker-compose.demo.yml`

Goal: a reproducible stack that builds the API+Worker image, starts Postgres + Redis with tmpfs (reset on every run), and runs a `drizzle-kit push` migration at startup. The stack exposes port 3000 on `localhost` (where the chaos script hits) and resolves `host.docker.internal` (where the fake endpoint listens).

**Files:**
- Create: `docker-compose.demo.yml`

- [ ] **Step 1: Write the file**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: vitrine_demo
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d vitrine_demo"]
      interval: 2s
      timeout: 3s
      retries: 20
    ports:
      - "5433:5432"  # avoid collision with the dev docker-compose.yml which uses 5432

  redis:
    image: redis:7-alpine
    tmpfs:
      - /data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
    ports:
      - "6380:6379"  # same, avoid collision with dev

  migrate:
    build:
      context: .
      dockerfile: docker/Dockerfile
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/vitrine_demo
    command: ["pnpm", "--filter", "@vitrine/db", "push", "--force"]
    restart: "no"

  api:
    build:
      context: .
      dockerfile: docker/Dockerfile
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/vitrine_demo
      REDIS_URL: redis://redis:6379
      MASTER_ENCRYPTION_KEY: ${MASTER_ENCRYPTION_KEY}
      LOG_LEVEL: info
      PORT: "3000"
      NODE_ENV: production
    command: ["pnpm", "--filter", "@vitrine/api", "start"]
    extra_hosts:
      - "host.docker.internal:host-gateway"  # make the fake endpoint reachable on Linux
    ports:
      - "3001:3000"  # 3001 on the host side to avoid collision with dev

  worker:
    build:
      context: .
      dockerfile: docker/Dockerfile
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/vitrine_demo
      REDIS_URL: redis://redis:6379
      MASTER_ENCRYPTION_KEY: ${MASTER_ENCRYPTION_KEY}
      LOG_LEVEL: info
      NODE_ENV: production
    command: ["pnpm", "--filter", "@vitrine/worker", "start"]
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

⚠️ Note: this compose depends on `docker/Dockerfile`, which does not exist yet (Task D.1). `docker compose build` will fail until the Dockerfile is written. This is intentional — the compose and the Dockerfile are a pair; they get committed together in Task D.1.

⚠️ Note: `MASTER_ENCRYPTION_KEY` must be injected by the shell that runs `docker compose`. The chaos script (Task C.4) generates it and passes it via `process.env`.

- [ ] **Step 2: Check the YAML syntax**

```bash
docker compose -f docker-compose.demo.yml config > /dev/null
```

Expected: no error (resolving `${MASTER_ENCRYPTION_KEY}` may warn if undefined, that's OK).

- [ ] **Step 3: Commit (buildable once D.1 is committed)**

```bash
git add docker-compose.demo.yml
git commit -m "feat(chaos): add demo compose stack (postgres+redis+api+worker)"
```

---

### Task C.2 — Implement `scripts/chaos/collector.ts`

The collector reads the system state on every tick (1 Hz for the duration of the demo). It counts events per status, reads the breaker state from Redis, and computes P50/P99 of the observed `duration_ms`.

**Files:**
- Create: `scripts/chaos/collector.ts`

- [ ] **Step 1: Write the file**

```typescript
import { type DbClient, deliveryAttempts, events } from '@vitrine/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { Redis } from 'ioredis'

export interface Sample {
  /** ms since the run's global startedAt */
  tMs: number
  delivered: number
  pending: number
  dead: number
  breakerState: 'closed' | 'open' | 'half_open' | 'unknown'
  breakerSkipCount: number
  /** P50 and P99 of duration_ms over attempts completed in the last window */
  p50LatencyMs: number | null
  p99LatencyMs: number | null
  totalAttempts: number
}

interface BreakerJson {
  state: 'closed' | 'open' | 'half_open'
  opened_at: number | null
  fail_count: number
  open_duration_ms: number
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx] ?? null
}

export async function sampleOnce(opts: {
  db: DbClient
  redis: Redis
  endpointId: string
  runStartedAt: number
  windowMs: number
}): Promise<Sample> {
  const { db, redis, endpointId, runStartedAt, windowMs } = opts
  const now = Date.now()

  const [statusRows, breakerJson, skipCount, recentLatencies] = await Promise.all([
    db
      .select({ status: events.status, n: count() })
      .from(events)
      .where(eq(events.endpointId, endpointId))
      .groupBy(events.status),
    redis.get(`breaker:${endpointId}`),
    redis.get(`breaker:skip_count:${endpointId}`).then((v) => (v ? Number(v) : 0)),
    db
      .select({ d: deliveryAttempts.durationMs })
      .from(deliveryAttempts)
      .innerJoin(events, eq(events.id, deliveryAttempts.eventId))
      .where(
        and(
          eq(events.endpointId, endpointId),
          gte(deliveryAttempts.attemptedAt, new Date(now - windowMs))
        )
      )
      .limit(500)
  ])

  let delivered = 0
  let pending = 0
  let dead = 0
  for (const r of statusRows) {
    if (r.status === 'delivered') delivered = Number(r.n)
    else if (r.status === 'pending') pending = Number(r.n)
    else if (r.status === 'dead') dead = Number(r.n)
  }

  let breakerState: Sample['breakerState'] = 'closed'
  if (breakerJson) {
    try {
      const parsed = JSON.parse(breakerJson) as BreakerJson
      breakerState = parsed.state
      // Lazy transition open → half_open: if the expiry has passed at read time,
      // display it as half_open in the viz (consistent with the runtime logic).
      if (
        parsed.state === 'open' &&
        parsed.opened_at !== null &&
        parsed.opened_at + parsed.open_duration_ms <= now
      ) {
        breakerState = 'half_open'
      }
    } catch {
      breakerState = 'unknown'
    }
  } else {
    breakerState = 'closed'
  }

  const sortedLatencies = recentLatencies.map((r) => r.d).sort((a, b) => a - b)

  return {
    tMs: now - runStartedAt,
    delivered,
    pending,
    dead,
    breakerState,
    breakerSkipCount: skipCount,
    p50LatencyMs: percentile(sortedLatencies, 50),
    p99LatencyMs: percentile(sortedLatencies, 99),
    totalAttempts: sortedLatencies.length
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm tsx --tsconfig tsconfig.base.json scripts/chaos/collector.ts 2>&1 || true
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/collector.ts
```

Expected: no type error.

If you get "Cannot find module '@vitrine/db'", check that the root `package.json` does have `"@vitrine/db": "workspace:*"` in devDependencies (added in A.1).

- [ ] **Step 3: Commit**

```bash
git add scripts/chaos/collector.ts
git commit -m "feat(chaos): add 1Hz sample collector (status counts + breaker + latency)"
```

---

### Task C.3 — Implement `scripts/chaos/render-png.ts`

Generates an annotated PNG. X = time in s. Left Y = counters (delivered/pending/dead, lines). Right Y = breaker state (step chart). Vertical bands for the phases. The PNG is saved to `docs/chaos-runs/`.

**Files:**
- Create: `scripts/chaos/render-png.ts`

- [ ] **Step 1: Write the file**

```typescript
import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ChartConfiguration, ChartType } from 'chart.js'
import type { Sample } from './collector'

interface PhaseAnnotation {
  startMs: number
  endMs: number
  label: string
  fillColor: string
}

const BREAKER_NUMERIC: Record<Sample['breakerState'], number> = {
  closed: 0,
  half_open: 1,
  open: 2,
  unknown: 0
}

export interface RenderInput {
  samples: Sample[]
  phases: PhaseAnnotation[]
  totalEvents: number
  outDir: string
  /** File name prefix, e.g. 2026-05-10-14-32 */
  fileStem: string
}

export async function renderChaosPng(input: RenderInput): Promise<string> {
  await mkdir(input.outDir, { recursive: true })
  const outPath = path.join(input.outDir, `${input.fileStem}.png`)

  const labels = input.samples.map((s) => (s.tMs / 1000).toFixed(0))
  const delivered = input.samples.map((s) => s.delivered)
  const pending = input.samples.map((s) => s.pending)
  const dead = input.samples.map((s) => s.dead)
  const breaker = input.samples.map((s) => BREAKER_NUMERIC[s.breakerState])

  // The chart.js "annotation" plugin is in the official namespace but not included
  // by default. To avoid an extra dependency, we bake the phase bands
  // in via a semi-transparent "bar" dataset in the background.

  const phaseBars = input.phases.map((p) => {
    const arr = labels.map((l) => {
      const t = Number(l) * 1000
      return t >= p.startMs && t < p.endMs ? Math.max(input.totalEvents, 1) : null
    })
    return {
      type: 'bar' as const,
      label: p.label,
      data: arr,
      backgroundColor: p.fillColor,
      borderWidth: 0,
      stack: 'phase',
      yAxisID: 'y',
      barPercentage: 1.0,
      categoryPercentage: 1.0,
      order: 99
    }
  })

  const config: ChartConfiguration<ChartType> = {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...phaseBars,
        {
          type: 'line',
          label: 'delivered',
          data: delivered,
          borderColor: '#16a34a',
          backgroundColor: '#16a34a',
          tension: 0.1,
          yAxisID: 'y',
          order: 1
        },
        {
          type: 'line',
          label: 'pending',
          data: pending,
          borderColor: '#f59e0b',
          backgroundColor: '#f59e0b',
          tension: 0.1,
          yAxisID: 'y',
          order: 2
        },
        {
          type: 'line',
          label: 'dead',
          data: dead,
          borderColor: '#dc2626',
          backgroundColor: '#dc2626',
          tension: 0.1,
          yAxisID: 'y',
          order: 3
        },
        {
          type: 'line',
          label: 'breaker (0=closed,1=half_open,2=open)',
          data: breaker,
          borderColor: '#2563eb',
          backgroundColor: '#2563eb',
          stepped: 'before',
          yAxisID: 'y2',
          order: 4
        }
      ]
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: `Chaos demo — ${input.totalEvents} events, ${labels.length}s sampling`
        },
        legend: { position: 'bottom' }
      },
      scales: {
        x: { title: { display: true, text: 'time (s)' } },
        y: {
          title: { display: true, text: 'events count' },
          beginAtZero: true
        },
        y2: {
          position: 'right',
          title: { display: true, text: 'breaker state' },
          min: 0,
          max: 2,
          ticks: { stepSize: 1 },
          grid: { drawOnChartArea: false }
        }
      }
    }
  }

  const chart = new ChartJSNodeCanvas({
    width: 1200,
    height: 600,
    backgroundColour: 'white'
  })
  const buffer = await chart.renderToBuffer(config, 'image/png')
  await writeFile(outPath, buffer)
  return outPath
}
```

⚠️ Note: this code does not depend on `chartjs-plugin-annotation` (an extra lib that is fragile under Node). Phase bands are rendered via a semi-transparent stacked bar dataset in the background, which makes the PNG self-contained.

- [ ] **Step 2: Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/render-png.ts
```

Expected: no error. If `Cannot find module 'chart.js'`, check that the peer dep is installed (Task A.1).

- [ ] **Step 3: Smoke test (synthetic PNG)**

```bash
pnpm tsx -e "
import { renderChaosPng } from './scripts/chaos/render-png.ts'
const samples = Array.from({ length: 20 }, (_, i) => ({
  tMs: i * 1000,
  delivered: i < 5 ? 0 : i * 5,
  pending: 100 - (i < 5 ? 0 : i * 5),
  dead: 0,
  breakerState: i < 3 ? 'closed' : i < 7 ? 'open' : i < 10 ? 'half_open' : 'closed',
  breakerSkipCount: 0,
  p50LatencyMs: 50,
  p99LatencyMs: 200,
  totalAttempts: 5
}))
const path = await renderChaosPng({
  samples,
  phases: [
    { startMs: 0, endMs: 10000, label: 'phase 1 (200 OK)', fillColor: 'rgba(34,197,94,0.08)' },
    { startMs: 10000, endMs: 15000, label: 'phase 2 (500)', fillColor: 'rgba(220,38,38,0.08)' },
    { startMs: 15000, endMs: 20000, label: 'phase 4 (200 OK)', fillColor: 'rgba(34,197,94,0.08)' }
  ],
  totalEvents: 100,
  outDir: 'docs/chaos-runs',
  fileStem: 'smoke-render'
})
console.log('written:', path)
"
ls -lh docs/chaos-runs/smoke-render.png
```

Expected: `written: docs/chaos-runs/smoke-render.png`, the file exists and is > 5 KB.

- [ ] **Step 4: Clean up the smoke output**

```bash
rm docs/chaos-runs/smoke-render.png
```

- [ ] **Step 5: Commit**

```bash
git add scripts/chaos/render-png.ts
git commit -m "feat(chaos): render delivery + breaker timeline to PNG via chartjs-node-canvas"
```

---

### Task C.4 — Implement `scripts/chaos/orchestrator.ts`

The orchestrator manages the docker-compose stack lifecycle, seeds a client + endpoint, and exposes the handles the runner needs.

**Files:**
- Create: `scripts/chaos/orchestrator.ts`

- [ ] **Step 1: Write the file**

```typescript
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { createDbClient, type DbClient } from '@vitrine/db'
import { seedClient, seedEndpoint } from '@vitrine/test-helpers'
import IORedis, { type Redis } from 'ioredis'

const COMPOSE_FILE = 'docker-compose.demo.yml'
const HOST_API_PORT = 3001
const HOST_PG_PORT = 5433
const HOST_REDIS_PORT = 6380
const DB_NAME = 'vitrine_demo'

export interface ChaosStack {
  apiBaseUrl: string
  databaseUrl: string
  redisUrl: string
  masterKey: Buffer
  db: DbClient
  redis: Redis
  apiKey: string
  clientId: string
  endpointId: string
  endpointSecret: string
  /** stops the compose and closes the clients */
  teardown: () => Promise<void>
}

function run(cmd: string, args: string[], env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

async function waitForApi(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await request(`${baseUrl}/ready`)
      if (r.statusCode === 200) {
        await r.body.dump()
        return
      }
      await r.body.dump()
    } catch {
      // not ready yet
    }
    await sleep(1000)
  }
  throw new Error(`API not ready at ${baseUrl} after ${timeoutMs}ms`)
}

export async function bootChaosStack(opts: {
  endpointUrl: string
}): Promise<ChaosStack> {
  const masterKey = randomBytes(32)
  const masterKeyB64 = masterKey.toString('base64')

  // 1) build + up the stack (migrate runs as init via depends_on)
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
  run(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build'],
    { MASTER_ENCRYPTION_KEY: masterKeyB64 }
  )

  const apiBaseUrl = `http://127.0.0.1:${HOST_API_PORT}`
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${HOST_PG_PORT}/${DB_NAME}`
  const redisUrl = `redis://127.0.0.1:${HOST_REDIS_PORT}`

  // 2) wait for /ready
  await waitForApi(apiBaseUrl, 60_000)

  // 3) seed client + endpoint via the test-helpers package helpers
  const db = createDbClient(databaseUrl)
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null })

  const { clientId, apiKey } = await seedClient(db, { name: 'chaos-demo' })
  const { endpointId, secret } = await seedEndpoint(db, {
    clientId,
    url: opts.endpointUrl,
    masterKey
  })

  return {
    apiBaseUrl,
    databaseUrl,
    redisUrl,
    masterKey,
    db,
    redis,
    apiKey,
    clientId,
    endpointId,
    endpointSecret: secret,
    teardown: async () => {
      try {
        await redis.quit()
      } catch {
        // ignore
      }
      // postgres-js: no trivial close on the drizzle interface; tearing down
      // the compose is enough to free the network resources on the host side.
      run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
    }
  }
}
```

⚠️ Note: `seedClient` and `seedEndpoint` come from `@vitrine/test-helpers` (Plan 1, Task E.x). They insert directly into the DB via Drizzle, which is faster than going through the CLI or the public API. Acceptable here because the chaos script is a demo tool, not a public boundary test.

⚠️ Note: `host.docker.internal` is not standard on Linux; `extra_hosts: host.docker.internal:host-gateway` (added in C.1) resolves it to the host gateway. On macOS, it is native via Docker Desktop.

- [ ] **Step 2: Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/orchestrator.ts
```

Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/chaos/orchestrator.ts
git commit -m "feat(chaos): orchestrate compose lifecycle, seed client + endpoint"
```

---

### Task C.5 — Implement `scripts/chaos/run.ts` (pnpm demo:chaos entry)

The runner orchestrates everything: starts the fake endpoint, boots the stack, pushes 100 events over 5 s, samples at 1 Hz for 140 s, generates the PNG, tears down.

**Files:**
- Create: `scripts/chaos/run.ts`

- [ ] **Step 1: Write the file**

```typescript
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { CHAOS_PHASES, startChaosFakeEndpoint } from './fake-endpoint.ts'
import { bootChaosStack } from './orchestrator.ts'
import { sampleOnce, type Sample } from './collector.ts'
import { renderChaosPng } from './render-png.ts'

const TOTAL_EVENTS = 100
const PUSH_DURATION_MS = 5_000
const RUN_DURATION_MS = 140_000  // 110 s phases + 30 s drain
const SAMPLE_INTERVAL_MS = 1_000

function fileStem(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join('-').replace(/-(?=\d{2}$)/, '-')  // 2026-05-10-14-32
}

async function pushEvents(opts: {
  apiBaseUrl: string
  apiKey: string
  endpointId: string
  total: number
  durationMs: number
}) {
  const interval = opts.durationMs / opts.total
  const tasks: Promise<void>[] = []
  for (let i = 0; i < opts.total; i++) {
    const t = Date.now()
    const task = (async () => {
      const r = await request(`${opts.apiBaseUrl}/events`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Idempotency-Key': `chaos-${i}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          endpoint_id: opts.endpointId,
          event_type: 'chaos.demo',
          payload: { i, ts: Date.now() }
        })
      })
      await r.body.dump()
      if (r.statusCode !== 202 && r.statusCode !== 200) {
        // eslint-disable-next-line no-console
        console.warn(`[push] event ${i}: status ${r.statusCode}`)
      }
    })()
    tasks.push(task)
    const elapsed = Date.now() - t
    if (elapsed < interval) await sleep(interval - elapsed)
  }
  await Promise.all(tasks)
}

async function main() {
  // eslint-disable-next-line no-console
  const log = (msg: string) => console.log(`[chaos] ${new Date().toISOString()} ${msg}`)

  log('starting fake endpoint')
  const fake = await startChaosFakeEndpoint({})
  log(`fake endpoint at ${fake.url}`)

  log('booting stack (docker compose up --build)')
  const stack = await bootChaosStack({ endpointUrl: fake.url })
  log(`stack ready, api at ${stack.apiBaseUrl}, endpoint=${stack.endpointId}`)

  const runStartedAt = Date.now()
  const samples: Sample[] = []

  // push the events in the first window
  log(`pushing ${TOTAL_EVENTS} events over ${PUSH_DURATION_MS}ms`)
  const pushPromise = pushEvents({
    apiBaseUrl: stack.apiBaseUrl,
    apiKey: stack.apiKey,
    endpointId: stack.endpointId,
    total: TOTAL_EVENTS,
    durationMs: PUSH_DURATION_MS
  })

  // sample for the whole duration
  let nextTick = Date.now()
  while (Date.now() - runStartedAt < RUN_DURATION_MS) {
    nextTick += SAMPLE_INTERVAL_MS
    const sample = await sampleOnce({
      db: stack.db,
      redis: stack.redis,
      endpointId: stack.endpointId,
      runStartedAt,
      windowMs: 2_000
    })
    samples.push(sample)
    log(
      `t=${(sample.tMs / 1000).toFixed(0).padStart(3, ' ')}s ` +
        `delivered=${sample.delivered} pending=${sample.pending} dead=${sample.dead} ` +
        `breaker=${sample.breakerState} skipCount=${sample.breakerSkipCount} ` +
        `p50=${sample.p50LatencyMs ?? '—'}ms p99=${sample.p99LatencyMs ?? '—'}ms`
    )
    const sleepMs = Math.max(0, nextTick - Date.now())
    await sleep(sleepMs)
  }

  await pushPromise
  log('run finished, generating PNG')

  const phases = CHAOS_PHASES.map((p, i, arr) => {
    const next = arr[i + 1]
    return {
      startMs: p.startMs,
      endMs: next ? next.startMs : RUN_DURATION_MS,
      label:
        p.behavior.kind === 'ok'
          ? `phase ${i + 1} (200 OK)`
          : p.behavior.kind === 'fail'
            ? `phase ${i + 1} (${p.behavior.statusCode})`
            : `phase ${i + 1} (mixed)`,
      fillColor:
        p.behavior.kind === 'ok'
          ? 'rgba(34,197,94,0.08)'
          : p.behavior.kind === 'fail'
            ? 'rgba(220,38,38,0.08)'
            : 'rgba(245,158,11,0.08)'
    }
  })

  const stem = fileStem(new Date())
  const pngPath = await renderChaosPng({
    samples,
    phases,
    totalEvents: TOTAL_EVENTS,
    outDir: 'docs/chaos-runs',
    fileStem: stem
  })
  log(`PNG written to ${pngPath}`)

  log('tearing down')
  await fake.close()
  await stack.teardown()
  log('done')
  // eslint-disable-next-line no-console
  console.log(pngPath)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 2: Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/run.ts
```

Expected: no error.

- [ ] **Step 3: Commit (full run tested in Task D.4 after the Dockerfile)**

```bash
git add scripts/chaos/run.ts
git commit -m "feat(chaos): orchestrate end-to-end chaos run with sampling and PNG output"
```

---

## Phase D — Shared API + Worker Docker image

### Task D.1 — Write `docker/Dockerfile`

Multi-stage image: (1) deps-only with pnpm fetch then install, (2) runtime that copies `node_modules` + the source. No TS build — we use `tsx` at runtime via the `start` script (pragmatic for a showcase project, avoids the packages → dist refactor).

**Files:**
- Create: `docker/Dockerfile`
- Modify: `apps/api/package.json` (script `start`)
- Modify: `apps/worker/package.json` (script `start`)

- [ ] **Step 1: Update the API `start` script**

`apps/api/package.json` — replace the line `"start": "node dist/server.js"` with:

```json
"start": "tsx src/server.ts"
```

Add `"tsx": "^4.19.0"` to `dependencies` (not `devDependencies`) of `apps/api/package.json` so it is installed in prod mode.

Expected final state for `apps/api/package.json`:

```json
{
  "name": "@vitrine/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p .",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@vitrine/core": "workspace:*",
    "@vitrine/db": "workspace:*",
    "@vitrine/queue": "workspace:*",
    "bullmq": "^5.0.0",
    "drizzle-orm": "^0.36.0",
    "fastify": "^5.0.0",
    "fastify-plugin": "^5.0.0",
    "ioredis": "^5.4.0",
    "pino": "^9.0.0",
    "tsx": "^4.19.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Same for the worker**

`apps/worker/package.json` — replace `"start": "node dist/worker.js"` with `"start": "tsx src/worker.ts"`. Move `tsx` from `devDependencies` to `dependencies`.

- [ ] **Step 3: Check that `pnpm --filter @vitrine/api start` works locally**

```bash
pnpm install
docker compose up -d  # to get Postgres + Redis on ports 5432/6379
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine pnpm db:push
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine \
  REDIS_URL=redis://localhost:6379 \
  MASTER_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  pnpm --filter @vitrine/api start &
API_PID=$!
sleep 3
curl -s http://localhost:3000/health
kill $API_PID
docker compose down
```

Expected: `{"ok":true}`. If there's an error, reset and investigate (often: a missing env var).

- [ ] **Step 4: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/test-helpers/package.json packages/test-helpers/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod=false

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/queue/node_modules ./packages/queue/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ apps/
COPY packages/ packages/
COPY scripts/ scripts/
EXPOSE 3000
# CMD is overridden by fly.toml [processes] (api/worker) and by docker-compose.demo.yml.
CMD ["pnpm", "--filter", "@vitrine/api", "start"]
```

⚠️ Note: `pnpm install --prod=false` is intentional. Drizzle-kit (used by the Fly `release_command` and the Compose migration) is in the `devDependencies` of the `db` package. Given the project's size, keeping the full install is simpler than hacking partial `--prod` installs with a rebuild step on the pnpm workspace side.

⚠️ Note: `tsx` must be visible from each app. Since it is in each app's `dependencies`, `pnpm --filter ... start` will resolve it via `node_modules/.bin/tsx`.

⚠️ Note: we also copy `packages/test-helpers` because the chaos demo (compose) `seedClient` is defined there. In real Fly prod, this package is never loaded by the API or the Worker (no import from `apps/`), so including it has no runtime impact.

- [ ] **Step 5: Write `.dockerignore`**

`/.dockerignore` :

```
node_modules
**/node_modules
**/dist
.git
.github
docs/chaos-runs/*.png
docs
tests
.env
.env.*
coverage
*.log
.DS_Store
```

- [ ] **Step 6: Build the image**

```bash
docker build -f docker/Dockerfile -t vitrine-webhook:dev .
```

Expected: successful build (may take 1-3 min the first time). An image size < 600 MB is acceptable.

- [ ] **Step 7: Smoke run of the isolated image**

```bash
docker run --rm vitrine-webhook:dev pnpm --filter @vitrine/api typecheck
```

Expected: typecheck passes. This confirms that the image does contain the TS source and that tsx can resolve it.

- [ ] **Step 8: Commit**

```bash
git add docker/Dockerfile .dockerignore apps/api/package.json apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(docker): add multi-stage image, switch start to tsx runtime"
```

---

### Task D.2 — Smoke run of the demo compose (build + up + down)

**Files:** no new file.

- [ ] **Step 1: Start the stack manually**

```bash
MASTER_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  docker compose -f docker-compose.demo.yml up -d --build
sleep 30
docker compose -f docker-compose.demo.yml ps
curl -s http://localhost:3001/ready
```

Expected: `{"ok":true}` (or a retry after a few seconds if the DB is not ready yet).

- [ ] **Step 2: Check the logs**

```bash
docker compose -f docker-compose.demo.yml logs api --tail 30
docker compose -f docker-compose.demo.yml logs worker --tail 30
```

Expected: API logs that it listens on 3000, worker logs its boot. No stack trace.

- [ ] **Step 3: Tear down**

```bash
docker compose -f docker-compose.demo.yml down -v
```

- [ ] **Step 4: No commit (runtime validation)**

---

### Task D.3 — End-to-end run of `pnpm demo:chaos`

**Files:**
- Create (per run): `docs/chaos-runs/YYYY-MM-DD-HH-MM.png`

- [ ] **Step 1: Run**

```bash
pnpm demo:chaos
```

The run takes ~2m30 (140 s sample window + ~30 s build/teardown). At the end, the script prints the PNG path to stdout.

- [ ] **Step 2: Check the PNG**

```bash
ls -lh docs/chaos-runs/
```

Expected: a PNG `YYYY-MM-DD-HH-MM.png` larger than 30 KB. Open it to visually check that the curves make sense:
- delivered climbs quickly in phase 1, plateaus or rises slowly in phase 2 (breaker open), recovers in phase 3, completes in phase 4
- breaker goes `closed → open → half_open → closed` somewhere between 10 s and 80 s

If the curve is flat or delivers 0 / 100, debug by reading the logs `docker compose -f docker-compose.demo.yml logs worker` then re-run.

- [ ] **Step 3: Keep this first PNG**

```bash
git add docs/chaos-runs/*.png
```

(Don't commit right away; we commit it with the README polish in Phase G, which references it.)

---

## Phase E — GitHub Actions CI

### Task E.1 — Workflow `ci.yml` (typecheck, lint, unit, integration)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the file**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    name: typecheck + lint + unit + integration
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9.12.0

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Lint
        run: pnpm lint

      - name: Unit tests
        run: pnpm test:unit

      - name: Integration tests (Testcontainers)
        run: pnpm test:integration
        env:
          # Testcontainers automatically detects the runner's Docker daemon.
          # This flag reduces log noise in CI.
          DEBUG: ''
```

⚠️ Note: GitHub-hosted `ubuntu-latest` has Docker preinstalled, which satisfies Testcontainers. No need for a `postgres:` service at the workflow level — Testcontainers spawns its own containers.

⚠️ Note: we don't include `pnpm demo:chaos` in CI (long, generates a PNG, per spec section 7.4).

- [ ] **Step 2: Check the syntax**

```bash
cat .github/workflows/ci.yml | grep -E '^\s*(name|on|jobs|runs-on|steps):'
```

Visual confirmation: structure consistent with a GitHub Actions workflow.

- [ ] **Step 3: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck + lint + unit + integration workflow"
```

- [ ] **Step 4: Push a test branch to validate**

If the branch is already on GitHub with an `origin` remote configured:

```bash
git push origin HEAD
```

Then check in the GitHub Actions UI that the workflow goes green. If red, fix locally and re-push.

If the repo is not on GitHub yet: defer this validation to Task F.4.

---

## Phase F — Fly.io deploy + workflow CD

### Task F.1 — Write `fly.toml` (1 app, 2 process groups)

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Choose an app name**

The user must choose a unique name on Fly. Convention in this plan: `vitrine-webhook-demo`. If the user already created another app with this name or prefers a different one, replace it throughout `fly.toml` and in the workflows.

- [ ] **Step 2: Write the file**

```toml
app = "vitrine-webhook-demo"
primary_region = "cdg"

[build]
  dockerfile = "docker/Dockerfile"

[deploy]
  release_command = "pnpm --filter @vitrine/db push --force"

[processes]
  api = "pnpm --filter @vitrine/api start"
  worker = "pnpm --filter @vitrine/worker start"

[env]
  LOG_LEVEL = "info"
  NODE_ENV = "production"
  PORT = "3000"

[[services]]
  processes = ["api"]
  protocol = "tcp"
  internal_port = 3000

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [services.concurrency]
    type = "connections"
    soft_limit = 200
    hard_limit = 250

  [[services.tcp_checks]]
    interval = "10s"
    timeout = "2s"
    grace_period = "10s"

[[vm]]
  processes = ["api"]
  size = "shared-cpu-1x"
  memory = "256mb"

[[vm]]
  processes = ["worker"]
  size = "shared-cpu-1x"
  memory = "512mb"
```

⚠️ Note: `release_command` runs in an ephemeral VM with access to the secrets — so `DATABASE_URL` must be set before the first deploy (Task F.2). Drizzle-kit reads `DATABASE_URL` automatically via `drizzle.config.ts`.

⚠️ Note: Fly convention is for `[[services]]` to be attached to the `api` process group only (the worker has no exposed HTTP port).

- [ ] **Step 3: Commit**

```bash
git add fly.toml
git commit -m "feat(fly): single app with api + worker process groups"
```

---

### Task F.2 — Manually provision Fly + Neon + Upstash (user steps)

⚠️ **This task is manual and produces no commit in the repo.** The plan documents the procedure so an operator can replay it without surprises.

- [ ] **Step 1: Install flyctl if needed**

```bash
brew install flyctl
flyctl auth login
```

- [ ] **Step 2: Create a Neon project (Postgres)**

1. https://console.neon.tech → New project, region `eu-central-1` (Frankfurt) or the one closest to Paris.
2. Suggested name: `vitrine-webhook`.
3. Grab the Neon `DATABASE_URL` (with `?sslmode=require`).

- [ ] **Step 3: Create an Upstash Redis**

1. https://console.upstash.com → New database, region `eu-west-1` or nearby.
2. Check "TLS" (`rediss://` URL).
3. Grab the `REDIS_URL`.

⚠️ Note: `ioredis` must accept `rediss://` for TLS. Check in `packages/queue/src/redis.ts` that the factory does not rewrite the protocol. If a test reveals an Upstash-specific TLS issue, add `tls: {}` to the ioredis options.

- [ ] **Step 4: Create the Fly app**

```bash
flyctl apps create vitrine-webhook-demo --org personal
```

(Adjust `--org` to the user's actual Fly organization name.)

- [ ] **Step 5: Set secrets**

```bash
flyctl secrets set \
  DATABASE_URL="<neon_url>" \
  REDIS_URL="<upstash_url>" \
  MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --app vitrine-webhook-demo
```

⚠️ Note: `MASTER_ENCRYPTION_KEY` is generated only once. If it is lost or rotated, all existing `secret_encrypted` values in the DB become undecryptable (the worker fails). Keep a private copy outside the repo.

- [ ] **Step 6: First manual deploy to validate**

```bash
flyctl deploy --app vitrine-webhook-demo
```

Expected: build, push, release_command runs the Drizzle push, then the API starts. At the end, `flyctl status` should show `api` and `worker` as `running`.

- [ ] **Step 7: Check the public URL**

```bash
flyctl apps list
flyctl info --app vitrine-webhook-demo
APP_URL=https://vitrine-webhook-demo.fly.dev
curl -s "$APP_URL/ready"
```

Expected: `{"ok":true}`.

- [ ] **Step 8: Create a real client and push a smoke event**

```bash
# Connect to Neon Postgres directly to seed
DATABASE_URL="<neon_url>" pnpm cli:create-client --name fly-smoke
# → note cl_secret_xxx

curl -s -X POST "$APP_URL/endpoints" \
  -H "Authorization: Bearer cl_secret_xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/post"}'
# → note ep_xxx + secret

curl -s -X POST "$APP_URL/events" \
  -H "Authorization: Bearer cl_secret_xxx" \
  -H "Idempotency-Key: fly-smoke-1" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_id":"ep_xxx","event_type":"smoke.test","payload":{"hello":"fly"}}'

sleep 5
curl -s "$APP_URL/events/evt_xxx" -H "Authorization: Bearer cl_secret_xxx"
# → status: "delivered"
```

Expected: `delivered`. If `pending`, debug via `flyctl logs --app vitrine-webhook-demo` and fix.

- [ ] **Step 9: Note the public URL for the README**

Store `https://vitrine-webhook-demo.fly.dev` (or variant) in a local note; it will be embedded in the README in Phase G.

---

### Task F.3 — `deploy.yml` workflow (CD on push to main)

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the file**

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Fly deploy
    runs-on: ubuntu-latest
    timeout-minutes: 10
    concurrency:
      group: fly-deploy
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - name: Deploy to Fly
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

⚠️ Note: `--remote-only` delegates the build to Fly's builder (avoids paying for the build in GitHub Actions). `concurrency.cancel-in-progress: false` prevents cancelling an in-progress deploy when a new commit arrives (preserves release_command durability).

- [ ] **Step 2: Provision the GitHub secret**

Manual: on GitHub → repo Settings → Secrets and variables → Actions → New repository secret → `FLY_API_TOKEN` = output of `flyctl auth token`.

```bash
flyctl auth token
```

Copy the value and paste it into GitHub Secrets.

- [ ] **Step 3: Commit + push to trigger**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add Fly deploy workflow on push to main"
git push origin HEAD
```

Check in GitHub Actions that `Deploy` runs and finishes green. Check in Fly that the version was incremented:

```bash
flyctl status --app vitrine-webhook-demo
```

---

### Task F.4 — Enable branch protection and validate the full CI flow

⚠️ Manual, no commit.

- [ ] **Step 1: Create a dummy PR**

```bash
git checkout -b ci-smoke
echo "" >> README.md  # noop diff
git commit -am "chore: trigger CI"
git push origin ci-smoke
gh pr create --title "ci: smoke" --body "Trigger CI workflows" --base main --head ci-smoke
```

- [ ] **Step 2: Observe**

The `CI` workflow should run on the PR. Check that the 4 steps (typecheck, lint, unit, integration) pass.

- [ ] **Step 3: Merge**

If green, merge the PR. The `Deploy` workflow should then trigger and redeploy Fly.

- [ ] **Step 4: Cleanup**

```bash
git checkout main
git pull
git branch -D ci-smoke
```

---

## Phase G — README polish + chaos PNG embed

### Task G.1 — Add deployment section + live link + CI badge

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the existing README to align the changes**

```bash
cat README.md
```

- [ ] **Step 2: Edit the top of the README to add the badge and the live URL**

Replace the intro block (the first lines of the README) with:

```markdown
# Webhook Delivery Service

[![CI](https://github.com/<USER>/<REPO>/actions/workflows/ci.yml/badge.svg)](https://github.com/<USER>/<REPO>/actions/workflows/ci.yml)

Node/TypeScript service that ingests events via an HTTP API and delivers them to third-party client endpoints, with exponential retry, circuit breaker, idempotency keys and manual replay. API model aligned with [Standard Webhooks](https://www.standardwebhooks.com).

> Showcase project. Not a production service used by real customers.

**Live demo**: https://vitrine-webhook-demo.fly.dev/ready (Fly.io single region `cdg` + Neon Postgres + Upstash Redis).
```

⚠️ Replace `<USER>` and `<REPO>` with the actual GitHub values. Replace the Fly URL with the real one if different.

- [ ] **Step 3: Add a "Chaos demo" section after "Tests"**

Find the line of the last `## Tests` and insert after it:

```markdown
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
```

⚠️ Replace `<FILE_STEM>` with the file name (without extension) of the PNG produced in Task D.3, for example `2026-05-10-14-32`.

- [ ] **Step 4: Add a "Deployment" section**

Before the `## Implementation plan` section, insert:

```markdown
## Deployment

Multi-stage Docker image (`docker/Dockerfile`) shared by the API and the Worker. Fly topology: a single app with two process groups (`api` exposed over HTTP, `worker` in the background).

```bash
flyctl deploy --app vitrine-webhook-demo
```

Drizzle migrations run automatically before each release via `release_command` in `fly.toml`. Secrets managed with `flyctl secrets set` (`DATABASE_URL`, `REDIS_URL`, `MASTER_ENCRYPTION_KEY`).

CD configured: push to `main` triggers `.github/workflows/deploy.yml`, which calls `flyctl deploy --remote-only`.
```

- [ ] **Step 5: Update the repo structure at the bottom of the README**

In the `## Repo structure` section, add the new directories:

```markdown
apps/
  api/                        # Fastify, routes endpoints + events + replay
  worker/                     # BullMQ consumer, deliver orchestrator
packages/
  core/                       # crypto, ids, retry schedule, signature, breaker logic
  db/                         # Drizzle schema + client
  queue/                      # BullMQ wrapper, Redis Lua scripts
  test-helpers/               # containers, app fixture, seed helpers
scripts/
  cli/                        # utility CLIs (create-client)
  chaos/                      # demo:chaos (orchestrator + fake endpoint + PNG)
docker/Dockerfile             # image multi-stage API + Worker
docker-compose.yml            # dev local (Postgres + Redis)
docker-compose.demo.yml       # chaos demo stack (builds the image)
fly.toml                      # Fly deployment (api + worker process groups)
.github/workflows/            # ci.yml + deploy.yml
tests/integration/            # 16 tests Testcontainers
docs/superpowers/             # specs and plans
docs/chaos-runs/              # PNG of the latest chaos run
```

- [ ] **Step 6: Check the rendering**

```bash
cat README.md | head -30
grep -c "fly.dev" README.md  # > 0 expected
grep -c "docs/chaos-runs/" README.md  # > 0 expected
```

- [ ] **Step 7: Commit with the chaos run PNG**

```bash
git add README.md docs/chaos-runs/*.png
git commit -m "docs: embed chaos PNG, add live URL and CI badge to README"
```

---

### Task G.2 — Document the "Out of scope V1" criterion verbatim from the spec

Spec section 1 explicitly requires this section to be reproduced verbatim. Plan 1 shipped a short version; we keep it but add an explicit link to section 10 of the spec, which contains the verbatim list. Check that the README points there.

**Files:**
- Modify: `README.md` (idempotent)

- [ ] **Step 1: Check that the link exists**

```bash
grep -n "section 10" README.md
```

Expected: at least one occurrence in the "Out of scope V1" section.

- [ ] **Step 2: If missing, add it**

Otherwise, in the `## Out of scope V1` section, check that there is something like:

> See [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md) section 10 for the exhaustive list.

- [ ] **Step 3: No separate commit if nothing to change**

If a change was made:

```bash
git add README.md
git commit -m "docs: link verbatim out-of-scope section in spec from README"
```

---

### Task G.3 — Final check of the completion criteria (Definition of Done V1)

⚠️ Validation task, no code.

Go through spec section 1 ("V1 completion criteria") point by point:

- [ ] **API routes specified in section 3** → check by reading `apps/api/src/routes/` that all spec routes are present (should be OK since Plan 1).
- [ ] **Unit + integration test suite green**:

```bash
pnpm test:unit && pnpm test:integration
```

Expected: all green.

- [ ] **`pnpm demo:chaos` end-to-end + PNG in `docs/chaos-runs/`**:

```bash
ls docs/chaos-runs/*.png
```

Expected: at least one PNG.

- [ ] **Service deployed on Fly.io, reachable via public URL**:

```bash
curl -s https://vitrine-webhook-demo.fly.dev/ready
```

Expected: `{"ok":true}`.

- [ ] **README**: description, Standard Webhooks link, local run, PNG embed, "Out of scope V1" section → visual check of `README.md`.

- [ ] **CI green on main**:

```bash
gh run list --workflow ci.yml --branch main --limit 3
```

Expected: all `completed` `success`.

- [ ] **Final step: Wrap-up commit (nothing if everything is already committed)**

If any drift is detected, fix + commit. Otherwise: optional end-of-plan tag:

```bash
git tag v1.0.0-vitrine-m6
```

---

## Self-review

The author of this plan reviews it:

**Spec coverage**:
- Section 1 (goals, V1 completion criteria)
  - "All API routes implemented" → covered by Plan 1, checked in G.3 ✓
  - "Unit+integration test suite green" → checked in E.1 (CI) and G.3 ✓
  - "Chaos script + PNG in docs/chaos-runs/" → Phases B + C + D.3 ✓
  - "Deployed on Fly.io, public URL" → Phase F ✓
  - "README" → Phase G ✓
  - "CI green on main" → Phase E ✓
- Section 7.3 (chaos demo) → Phases B + C ✓
- Section 7.4 (CI) → Phase E ✓
- Section 9 (deployment) → Phases D + F ✓

**Placeholder scan**:
- "TBD" / "TODO": none.
- "Add appropriate error handling": none. Errors are explicit (try/catch in `bootChaosStack.teardown`, `pushEvents` warns on non-2xx status).
- "Similar to Task N": not used. Each task repeats its code.
- ⚠️ Notes used as guardrails (not placeholders): compose ↔ Dockerfile pairing in C.1, host.docker.internal on Linux in C.4, `--prod=false` justified in D.1, `MASTER_ENCRYPTION_KEY` not rotatable in F.2.5.

**Type consistency**:
- `Sample` defined in C.2, consumed in C.3 and C.5 ✓
- `PhaseConfig` / `CHAOS_PHASES` defined in B.1, consumed in C.5 ✓
- `ChaosStack` defined in C.4, consumed in C.5 ✓
- `bootChaosStack({ endpointUrl })` consistent between C.4 and C.5 ✓
- `seedClient` / `seedEndpoint` come from `@vitrine/test-helpers` (Plan 1) — interface compatible with `seedClient(db, { name })` returning `{ clientId, apiKey }`, and `seedEndpoint(db, { clientId, url, masterKey })` returning `{ endpointId, secret }`. Consistent with the current signature in the repo (verified) ✓
- `apiBaseUrl` / `apiKey` / `endpointId` consistent between orchestrator and runner ✓
- API/Worker `start` script consistent between D.1 (package.json change), docker-compose.demo.yml C.1 (`pnpm --filter ... start`) and fly.toml F.1 (`pnpm --filter ... start`) ✓

**Issues fixed inline**:
- C.3 originally used `chartjs-plugin-annotation`; replaced with a semi-transparent stacked bar dataset to avoid a fragile dependency.
- D.1 originally used `tsc --build` then `node dist/server.js`; switched to tsx at runtime (consistent with `packages/*/src/index.ts` exporting TS directly).
- F.1 originally two separate fly apps; consolidated into a single app with process groups after reading spec section 9, which allows both.

---

## Plan complete and saved

`docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-chaos-deploy.md`

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute the tasks in this session via executing-plans, batch execution with checkpoints.

Which one?
