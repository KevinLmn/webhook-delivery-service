# Webhook Delivery Hot Path — Chaos Demo + Fly Deploy + CI Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compléter les milestones M5 (chaos demo avec PNG narratif) et M6 (Dockerfile + Fly.io + GitHub Actions CI/CD + README final) du spec, à partir du service Node/TS local entièrement fonctionnel produit par Plan 1.

**Architecture:** Un script standalone `scripts/chaos/run.ts` qui orchestre une démo end-to-end (fake endpoint scénarisé en 4 phases, push de 100 events, sampling à 1 Hz, génération PNG via `chartjs-node-canvas`). Un Dockerfile multi-stage pour packager l'image partagée API+Worker. Un seul Fly app avec deux `[processes]` (api, worker) qui partagent l'image et les secrets. Un workflow GitHub Actions `ci.yml` pour typecheck + lint + unit + integration, un workflow `deploy.yml` pour `flyctl deploy` sur push to `main`.

**Tech Stack:** Node.js 22 LTS, pnpm 9, `chartjs-node-canvas` 4.x, Docker (multi-stage Alpine), Fly.io (`flyctl`), GitHub Actions (`ubuntu-latest`, hosted Docker).

**Prérequis Plan 2** : Plan 1 entièrement exécuté, suite `pnpm test:integration` verte localement, `pnpm dev` capable de servir un POST /events qui finit en `delivered`.

---

## Spec de référence

`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`. Les sections directement adressées par ce plan :
- Section 1 — critère "déployé sur Fly.io accessible via URL publique" + "PNG chaos run le plus récent embedé".
- Section 7.3 — chaos demo (script, scénario 4 phases, génération PNG).
- Section 7.4 — CI (typecheck, lint, unit, integration).
- Section 9 — déploiement (Fly.io + Neon + Upstash, Dockerfile multi-stage, secrets, release_command).
- Annexe — `chartjs-node-canvas` ou alternative.

Toute incohérence entre ce plan et le spec se résout en faveur du spec.

---

## File structure cible (delta sur l'état Plan 1)

```
vitrine/
├── scripts/
│   └── chaos/
│       ├── run.ts                  # entrée — pnpm demo:chaos
│       ├── fake-endpoint.ts        # serveur Fastify scénarisé 4 phases
│       ├── collector.ts            # sampling à 1 Hz (events stats + breaker + latency)
│       ├── render-png.ts           # chartjs-node-canvas → PNG
│       └── orchestrator.ts         # spin compose, seed, run, teardown
├── docs/
│   └── chaos-runs/
│       ├── .gitkeep
│       └── 2026-05-XX-HH-MM.png    # généré au premier run, puis committé
├── docker/
│   └── Dockerfile                  # multi-stage, image partagée API+Worker
├── docker-compose.demo.yml         # Postgres + Redis + API + Worker (image buildée)
├── .dockerignore
├── fly.toml                        # un seul app, processes api + worker
├── .github/
│   └── workflows/
│       ├── ci.yml                  # typecheck + lint + unit + integration
│       └── deploy.yml              # flyctl deploy on push main
├── README.md                       # MAJ : badge CI, URL Fly, PNG embed
└── package.json                    # MAJ : script demo:chaos, deps chartjs-node-canvas
```

Les autres dossiers (`apps/`, `packages/`, `tests/`) restent inchangés sauf modifications ponctuelles documentées (ex : ajout d'un script `start` propre à chaque app).

---

## Décisions verrouillées avant exécution

| Sujet | Choix retenu | Raison |
|---|---|---|
| Lib chart PNG | `chartjs-node-canvas` 4.x | Spec section 7.3, mainstream, rendu déterministe |
| Topologie Fly | 1 app, 2 process groups (`api`, `worker`) | Simplifie secrets et CI/CD ; spec autorise |
| Build images | Pas de tsup, on garde tsx en runtime | Évite refactor du build packages, image reste légère, vitesse start négligeable pour vitrine |
| Migrations en prod | `pnpm --filter @vitrine/db push --force` en `release_command` Fly | Cohérent avec Testcontainers, pas de journal `__drizzle_migrations` |
| Chaos infra | `docker-compose.demo.yml` qui build l'image (API+Worker) + Postgres + Redis | Spec section 7.3, isole le run de l'environnement dev |
| Persistance Redis demo | `tmpfs` dans le compose | Reset garanti à chaque run |
| Postgres demo | `tmpfs` également | Idem |
| Sampling chaos | 1 Hz (1s tick) | Spec section 7.3 |
| Push events | 100 sur 5 s = 20 events/s, throttlé via Promise queue de concurrence 10 | Évite saturer le port local |
| Phases scénarisées | 0-10 s 200 OK ; 10-40 s 500 ; 40-80 s 50/50 ; 80-110 s 200 OK | Spec section 7.3 ; durée totale 110 s + 30 s drain |
| Fenêtre de drain | 30 s après fin phase 4 | Couvre les retries 1 s + 10 s sans être trop long |

---

## Phase A — Préparation des dépendances et arborescence

### Task A.1 — Ajouter les dépendances chaos au workspace root

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Modify: `pnpm-lock.yaml` (auto)

- [ ] **Step 1 : Ajouter `chartjs-node-canvas` et `chart.js` (peer) en devDependencies du root**

Edit `package.json`. Sous `devDependencies`, ajouter `"chartjs-node-canvas": "^4.1.6"` et `"chart.js": "^4.4.0"`. Ajouter aussi `"undici": "^6.20.0"` si pas déjà présent au root (utilisé par le chaos collector pour appeler l'API). Ajouter `"ioredis": "^5.4.0"` au root devDeps si absent (le chaos collector lit `breaker:*` directement). Ajouter `"@vitrine/db": "workspace:*"` au root devDeps si pas déjà présent.

Sous `scripts`, ajouter :

```json
"demo:chaos": "tsx scripts/chaos/run.ts"
```

État final attendu de la section `scripts` :

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

- [ ] **Step 2 : Installer**

Run :

```bash
pnpm install
```

Expected : pas d'erreur, `pnpm-lock.yaml` mis à jour, `node_modules/chartjs-node-canvas` présent.

- [ ] **Step 3 : Vérifier que `chartjs-node-canvas` charge bien sur cette machine**

Run :

```bash
node --input-type=module -e "import('chartjs-node-canvas').then(m => console.log(typeof m.ChartJSNodeCanvas))"
```

Expected output : `function`.

Si l'import échoue avec une erreur native (cairo, pango), c'est que `node-canvas` n'a pas pu binder. Sur macOS : `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman`, puis `pnpm rebuild canvas`. Documenter dans le README la dépendance native si nécessaire.

- [ ] **Step 4 : Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add chartjs-node-canvas and chaos script entry"
```

---

### Task A.2 — Créer l'arborescence chaos vide + .gitkeep

**Files:**
- Create: `scripts/chaos/.gitkeep` (placeholder, sera supprimé en A.3+)
- Create: `docs/chaos-runs/.gitkeep`

- [ ] **Step 1 : Créer les dossiers**

```bash
mkdir -p scripts/chaos docs/chaos-runs
touch scripts/chaos/.gitkeep docs/chaos-runs/.gitkeep
```

- [ ] **Step 2 : Vérifier**

```bash
ls scripts/chaos docs/chaos-runs
```

Expected : `.gitkeep` dans les deux.

- [ ] **Step 3 : Commit**

```bash
git add scripts/chaos/.gitkeep docs/chaos-runs/.gitkeep
git commit -m "chore: scaffold scripts/chaos and docs/chaos-runs directories"
```

---

## Phase B — Chaos demo : fake endpoint scénarisé

### Task B.1 — Implémenter `scripts/chaos/fake-endpoint.ts`

Le fake endpoint réutilise la même idée que `packages/test-helpers/src/fake-endpoint.ts` mais avec un scénario piloté par le temps écoulé depuis le démarrage. Pas mutualisé volontairement : le fake endpoint des tests est piloté manuellement (`setResponse`), celui du chaos suit une courbe automatique. DRY ne s'applique pas — boundaries différentes.

**Files:**
- Create: `scripts/chaos/fake-endpoint.ts`
- Delete: `scripts/chaos/.gitkeep` (si présent)

- [ ] **Step 1 : Écrire le fichier**

```typescript
import Fastify, { type FastifyInstance } from 'fastify'

export interface PhaseConfig {
  /** ms depuis startTime auquel cette phase prend effet */
  startMs: number
  /** Comportement de l'endpoint pendant cette phase */
  behavior:
    | { kind: 'ok' }
    | { kind: 'fail'; statusCode: number }
    | { kind: 'mixed'; failRatio: number; failStatusCode: number }
}

export interface FakeEndpoint {
  url: string
  startedAt: number
  /** Nombre cumulé de requêtes reçues */
  totalReceived: () => number
  /** Phase active à un instant donné (pour annoter le PNG) */
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

  // 0.0.0.0 pour être joignable depuis le conteneur worker via host.docker.internal
  await app.listen({ host: '0.0.0.0', port: opts.port ?? 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')

  // L'URL communiquée à l'API doit pointer vers le host depuis l'intérieur du worker
  // Docker. Sur Docker Desktop (mac/win), `host.docker.internal` résout le host.
  // Sur Linux, on passe par `--add-host=host.docker.internal:host-gateway` dans le compose.
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

- [ ] **Step 2 : Typecheck**

```bash
pnpm tsc --noEmit scripts/chaos/fake-endpoint.ts
```

Expected : pas d'erreur. Si `Fastify`/`fastify` n'est pas en deps root, ajouter `"fastify": "^5.0.0"` dans `package.json` devDependencies puis `pnpm install`.

- [ ] **Step 3 : Smoke test isolé**

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

Note : Node 22 sans tsx ne charge pas `.ts` directement. Préférer :

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

Expected output (parmi les lignes) :

```
url: http://host.docker.internal:<port>/hook
phase at 0ms: 1
phase at 15000ms: 2
phase at 50000ms: 3
phase at 90000ms: 4
```

- [ ] **Step 4 : Commit**

```bash
git rm scripts/chaos/.gitkeep 2>/dev/null || true
git add scripts/chaos/fake-endpoint.ts
git commit -m "feat(chaos): add scenarised fake endpoint with 4-phase schedule"
```

---

## Phase C — Chaos demo : compose stack et orchestration

### Task C.1 — Créer `docker-compose.demo.yml`

L'objectif : un stack reproducible qui build l'image API+Worker, lance Postgres + Redis avec tmpfs (reset à chaque run), et exécute une migration `drizzle-kit push` au démarrage. Le stack expose le port 3000 sur `localhost` (où le chaos script tape) et résout `host.docker.internal` (où le fake endpoint écoute).

**Files:**
- Create: `docker-compose.demo.yml`

- [ ] **Step 1 : Écrire le fichier**

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
      - "5433:5432"  # éviter collision avec docker-compose.yml dev qui occupe 5432

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
      - "6380:6379"  # idem, éviter collision avec dev

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
      - "host.docker.internal:host-gateway"  # rendre le fake endpoint joignable sous Linux
    ports:
      - "3001:3000"  # 3001 côté host pour éviter collision avec dev

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

⚠️ Note : ce compose dépend de `docker/Dockerfile` qui n'existe pas encore (Task D.1). Le `docker compose build` échouera tant que le Dockerfile n'est pas écrit. C'est intentionnel — le compose et le Dockerfile sont une paire ; on les commit ensemble en Task D.1.

⚠️ Note : `MASTER_ENCRYPTION_KEY` doit être injecté par le shell qui lance `docker compose`. Le chaos script (Task C.4) le génère et le passe via `process.env`.

- [ ] **Step 2 : Vérifier la syntaxe YAML**

```bash
docker compose -f docker-compose.demo.yml config > /dev/null
```

Expected : pas d'erreur (la résolution de `${MASTER_ENCRYPTION_KEY}` peut warn si non défini, c'est OK).

- [ ] **Step 3 : Commit (sera buildable une fois D.1 commité)**

```bash
git add docker-compose.demo.yml
git commit -m "feat(chaos): add demo compose stack (postgres+redis+api+worker)"
```

---

### Task C.2 — Implémenter `scripts/chaos/collector.ts`

Le collector lit l'état du système à chaque tick (1 Hz pendant la durée de la démo). Il compte les events par status, lit l'état du breaker depuis Redis, et calcule P50/P99 des `duration_ms` observés.

**Files:**
- Create: `scripts/chaos/collector.ts`

- [ ] **Step 1 : Écrire le fichier**

```typescript
import { type DbClient, deliveryAttempts, events } from '@vitrine/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { Redis } from 'ioredis'

export interface Sample {
  /** ms depuis le startedAt global du run */
  tMs: number
  delivered: number
  pending: number
  dead: number
  breakerState: 'closed' | 'open' | 'half_open' | 'unknown'
  breakerSkipCount: number
  /** P50 et P99 des duration_ms sur les attempts terminées dans la dernière fenêtre */
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
      // Lazy transition open → half_open : si l'expiration est dépassée à la lecture,
      // on l'affiche comme half_open dans la viz (cohérent avec la logique runtime).
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

- [ ] **Step 2 : Typecheck**

```bash
pnpm tsx --tsconfig tsconfig.base.json scripts/chaos/collector.ts 2>&1 || true
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/collector.ts
```

Expected : pas d'erreur de type.

Si erreur "Cannot find module '@vitrine/db'", vérifier que le root `package.json` a bien `"@vitrine/db": "workspace:*"` en devDependencies (ajouté en A.1).

- [ ] **Step 3 : Commit**

```bash
git add scripts/chaos/collector.ts
git commit -m "feat(chaos): add 1Hz sample collector (status counts + breaker + latency)"
```

---

### Task C.3 — Implémenter `scripts/chaos/render-png.ts`

Génère un PNG annoté. X = temps en s. Y gauche = compteurs (delivered/pending/dead, lignes). Y droite = breaker state (step chart). Bandes verticales pour les phases. Le PNG est sauvé dans `docs/chaos-runs/`.

**Files:**
- Create: `scripts/chaos/render-png.ts`

- [ ] **Step 1 : Écrire le fichier**

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
  /** Préfixe nom de fichier, ex 2026-05-10-14-32 */
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

  // chart.js plugin "annotation" est dans le namespace officiel mais pas inclus
  // par défaut. Pour rester sans dépendance supplémentaire, on bake les bandes
  // de phase via un dataset de type "bar" semi-transparent en arrière-plan.

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

⚠️ Note : ce code ne dépend pas de `chartjs-plugin-annotation` (lib supplémentaire fragile sous Node). Les bandes de phase sont rendues via un dataset bar empilé semi-transparent en arrière-plan, ce qui rend le PNG auto-suffisant.

- [ ] **Step 2 : Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/render-png.ts
```

Expected : pas d'erreur. Si `Cannot find module 'chart.js'`, vérifier que la dep peer est bien installée (Task A.1).

- [ ] **Step 3 : Smoke test (PNG synthétique)**

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

Expected : `written: docs/chaos-runs/smoke-render.png`, le fichier existe et fait > 5 KB.

- [ ] **Step 4 : Nettoyer le smoke**

```bash
rm docs/chaos-runs/smoke-render.png
```

- [ ] **Step 5 : Commit**

```bash
git add scripts/chaos/render-png.ts
git commit -m "feat(chaos): render delivery + breaker timeline to PNG via chartjs-node-canvas"
```

---

### Task C.4 — Implémenter `scripts/chaos/orchestrator.ts`

L'orchestrator gère le cycle de vie du stack docker-compose, seed un client + endpoint, et expose les handles dont a besoin le runner.

**Files:**
- Create: `scripts/chaos/orchestrator.ts`

- [ ] **Step 1 : Écrire le fichier**

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
  /** stop le compose et ferme les clients */
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
      // pas encore prêt
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

  // 1) build + up le stack (migrate s'exécute en init via depends_on)
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
  run(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build'],
    { MASTER_ENCRYPTION_KEY: masterKeyB64 }
  )

  const apiBaseUrl = `http://127.0.0.1:${HOST_API_PORT}`
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${HOST_PG_PORT}/${DB_NAME}`
  const redisUrl = `redis://127.0.0.1:${HOST_REDIS_PORT}`

  // 2) attendre /ready
  await waitForApi(apiBaseUrl, 60_000)

  // 3) seed client + endpoint via les helpers du package test-helpers
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
      // postgres-js : pas de close trivial sur l'interface drizzle ; le tear down
      // du compose suffit à libérer les ressources réseau côté host.
      run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
    }
  }
}
```

⚠️ Note : `seedClient` et `seedEndpoint` viennent de `@vitrine/test-helpers` (Plan 1, Task E.x). Ils insèrent directement en DB via Drizzle, ce qui est plus rapide que de passer par la CLI ou l'API publique. Acceptable ici car le chaos script est un outil de demo, pas un test de boundary publique.

⚠️ Note : `host.docker.internal` n'est pas standard sur Linux ; `extra_hosts: host.docker.internal:host-gateway` (ajouté en C.1) le résout vers la passerelle de l'hôte. Sur macOS, c'est natif via Docker Desktop.

- [ ] **Step 2 : Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/orchestrator.ts
```

Expected : pas d'erreur.

- [ ] **Step 3 : Commit**

```bash
git add scripts/chaos/orchestrator.ts
git commit -m "feat(chaos): orchestrate compose lifecycle, seed client + endpoint"
```

---

### Task C.5 — Implémenter `scripts/chaos/run.ts` (entrée pnpm demo:chaos)

Le runner orchestre l'ensemble : démarre le fake endpoint, boote le stack, push 100 events sur 5 s, sample à 1 Hz pendant 140 s, génère le PNG, teardown.

**Files:**
- Create: `scripts/chaos/run.ts`

- [ ] **Step 1 : Écrire le fichier**

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

  // pousse les events dans la première fenêtre
  log(`pushing ${TOTAL_EVENTS} events over ${PUSH_DURATION_MS}ms`)
  const pushPromise = pushEvents({
    apiBaseUrl: stack.apiBaseUrl,
    apiKey: stack.apiKey,
    endpointId: stack.endpointId,
    total: TOTAL_EVENTS,
    durationMs: PUSH_DURATION_MS
  })

  // sample pendant toute la durée
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

- [ ] **Step 2 : Typecheck**

```bash
pnpm tsc --noEmit --project tsconfig.base.json scripts/chaos/run.ts
```

Expected : pas d'erreur.

- [ ] **Step 3 : Commit (test full run en Task D.4 après Dockerfile)**

```bash
git add scripts/chaos/run.ts
git commit -m "feat(chaos): orchestrate end-to-end chaos run with sampling and PNG output"
```

---

## Phase D — Image Docker partagée API + Worker

### Task D.1 — Écrire `docker/Dockerfile`

Image multi-stage : (1) deps-only avec pnpm fetch puis install, (2) runtime qui copie `node_modules` + le source. Pas de build TS — on utilise `tsx` au runtime via le script `start` (pragmatique pour un projet vitrine, évite le refactor packages → dist).

**Files:**
- Create: `docker/Dockerfile`
- Modify: `apps/api/package.json` (script `start`)
- Modify: `apps/worker/package.json` (script `start`)

- [ ] **Step 1 : Mettre à jour le script `start` de l'API**

`apps/api/package.json` — remplacer la ligne `"start": "node dist/server.js"` par :

```json
"start": "tsx src/server.ts"
```

Ajouter `"tsx": "^4.19.0"` dans `dependencies` (et non `devDependencies`) de `apps/api/package.json` pour qu'il soit installé en prod-mode.

État final attendu pour `apps/api/package.json` :

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

- [ ] **Step 2 : Idem pour le worker**

`apps/worker/package.json` — remplacer `"start": "node dist/worker.js"` par `"start": "tsx src/worker.ts"`. Déplacer `tsx` de `devDependencies` vers `dependencies`.

- [ ] **Step 3 : Vérifier que `pnpm --filter @vitrine/api start` marche localement**

```bash
pnpm install
docker compose up -d  # pour avoir Postgres + Redis sur ports 5432/6379
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

Expected : `{"ok":true}`. Si erreur, reset et investiguer (souvent : env var manquante).

- [ ] **Step 4 : Écrire le Dockerfile**

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
# Le CMD est surchargé par fly.toml [processes] (api/worker) et par docker-compose.demo.yml.
CMD ["pnpm", "--filter", "@vitrine/api", "start"]
```

⚠️ Note : `pnpm install --prod=false` est volontaire. Drizzle-kit (utilisé par le `release_command` Fly et la migration Compose) est en `devDependencies` du package `db`. Vu la taille du projet, garder le full install est plus simple que de bricoler des `--prod` partiels avec une étape de rebuild côté workspace pnpm.

⚠️ Note : `tsx` doit être visible depuis chaque app. Comme il est en `dependencies` de chaque app, le `pnpm --filter ... start` le résoudra via `node_modules/.bin/tsx`.

⚠️ Note : on copie `packages/test-helpers` aussi car le chaos demo (compose) `seedClient` y est défini. En prod réelle Fly, ce package n'est jamais chargé par l'API ou le Worker (pas d'import depuis `apps/`), donc son inclusion est sans impact runtime.

- [ ] **Step 5 : Écrire `.dockerignore`**

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

- [ ] **Step 6 : Build l'image**

```bash
docker build -f docker/Dockerfile -t vitrine-webhook:dev .
```

Expected : build réussi (peut prendre 1-3 min la première fois). Image taillée < 600 MB est acceptable.

- [ ] **Step 7 : Smoke run de l'image isolée**

```bash
docker run --rm vitrine-webhook:dev pnpm --filter @vitrine/api typecheck
```

Expected : typecheck passe. Cela valide que l'image contient bien le source TS et que tsx peut le résoudre.

- [ ] **Step 8 : Commit**

```bash
git add docker/Dockerfile .dockerignore apps/api/package.json apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(docker): add multi-stage image, switch start to tsx runtime"
```

---

### Task D.2 — Smoke run du compose demo (build + up + down)

**Files:** aucun nouveau fichier.

- [ ] **Step 1 : Lancer le stack manuellement**

```bash
MASTER_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  docker compose -f docker-compose.demo.yml up -d --build
sleep 30
docker compose -f docker-compose.demo.yml ps
curl -s http://localhost:3001/ready
```

Expected : `{"ok":true}` (ou un retry après quelques secondes si la DB n'est pas encore prête).

- [ ] **Step 2 : Vérifier les logs**

```bash
docker compose -f docker-compose.demo.yml logs api --tail 30
docker compose -f docker-compose.demo.yml logs worker --tail 30
```

Expected : API loggue qu'elle écoute sur 3000, worker loggue son boot. Pas de stack trace.

- [ ] **Step 3 : Tear down**

```bash
docker compose -f docker-compose.demo.yml down -v
```

- [ ] **Step 4 : Pas de commit (validation runtime)**

---

### Task D.3 — Run end-to-end de `pnpm demo:chaos`

**Files:**
- Create (par run) : `docs/chaos-runs/YYYY-MM-DD-HH-MM.png`

- [ ] **Step 1 : Lancer**

```bash
pnpm demo:chaos
```

Le run prend ~2m30 (140 s sample window + ~30 s build/teardown). À la fin, le script imprime le path du PNG sur stdout.

- [ ] **Step 2 : Vérifier le PNG**

```bash
ls -lh docs/chaos-runs/
```

Expected : un PNG `YYYY-MM-DD-HH-MM.png` de taille > 30 KB. Ouvrir visuellement pour vérifier que les courbes sont cohérentes :
- delivered grimpe rapidement en phase 1, plateau ou plateau lent en phase 2 (breaker open), reprise en phase 3, complétude en phase 4
- breaker passe `closed → open → half_open → closed` quelque part entre 10 s et 80 s

Si la courbe est plate ou délivre 0 / 100, debug en lisant les logs `docker compose -f docker-compose.demo.yml logs worker` puis re-run.

- [ ] **Step 3 : Garder ce premier PNG**

```bash
git add docs/chaos-runs/*.png
```

(Ne pas commit tout de suite ; on commit avec le README polish en Phase G qui le référence.)

---

## Phase E — GitHub Actions CI

### Task E.1 — Workflow `ci.yml` (typecheck, lint, unit, integration)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1 : Écrire le fichier**

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
          # Testcontainers détecte automatiquement le Docker daemon de runner.
          # Ce flag réduit le bruit de logs en CI.
          DEBUG: ''
```

⚠️ Note : `ubuntu-latest` GitHub-hosted a Docker préinstallé, ce qui satisfait Testcontainers. Pas besoin d'un service `postgres:` au niveau workflow — Testcontainers spawn ses propres conteneurs.

⚠️ Note : on n'inclut pas `pnpm demo:chaos` en CI (long, génère un PNG, conformément au spec section 7.4).

- [ ] **Step 2 : Vérifier la syntaxe**

```bash
cat .github/workflows/ci.yml | grep -E '^\s*(name|on|jobs|runs-on|steps):'
```

Confirmation visuelle : structure cohérente avec un workflow GitHub Actions.

- [ ] **Step 3 : Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck + lint + unit + integration workflow"
```

- [ ] **Step 4 : Push une branche test pour valider**

Si la branche est déjà sur GitHub avec un remote `origin` configuré :

```bash
git push origin HEAD
```

Ensuite, observer sur l'interface GitHub Actions que le workflow passe vert. Si rouge, corriger localement et re-push.

Si le repo n'est pas encore sur GitHub : reporter cette validation à Task F.4.

---

## Phase F — Fly.io deploy + workflow CD

### Task F.1 — Écrire `fly.toml` (1 app, 2 process groups)

**Files:**
- Create: `fly.toml`

- [ ] **Step 1 : Choisir un nom d'app**

L'utilisateur doit choisir un nom unique sur Fly. Convention dans ce plan : `vitrine-webhook-demo`. Si l'utilisateur a déjà créé une autre app avec ce nom ou s'il préfère un autre, remplacer dans tout `fly.toml` et dans les workflows.

- [ ] **Step 2 : Écrire le fichier**

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

⚠️ Note : `release_command` tourne dans une éphémère VM avec accès aux secrets — `DATABASE_URL` doit donc être set avant le premier deploy (Task F.2). Drizzle-kit lit `DATABASE_URL` automatiquement via `drizzle.config.ts`.

⚠️ Note : la convention Fly veut que `[[services]]` soit attaché au process group `api` uniquement (le worker n'a pas de port HTTP exposé).

- [ ] **Step 3 : Commit**

```bash
git add fly.toml
git commit -m "feat(fly): single app with api + worker process groups"
```

---

### Task F.2 — Provisionner manuellement Fly + Neon + Upstash (étapes utilisateur)

⚠️ **Cette task est manuelle et ne produit pas de commit dans le repo.** Le plan documente la procédure pour qu'un opérateur la rejoue sans surprise.

- [ ] **Step 1 : Installer flyctl si nécessaire**

```bash
brew install flyctl
flyctl auth login
```

- [ ] **Step 2 : Créer un projet Neon (Postgres)**

1. https://console.neon.tech → New project, region `eu-central-1` (Frankfurt) ou la plus proche de Paris.
2. Nom suggéré : `vitrine-webhook`.
3. Récupérer la `DATABASE_URL` Neon (avec `?sslmode=require`).

- [ ] **Step 3 : Créer un Upstash Redis**

1. https://console.upstash.com → New database, region `eu-west-1` ou proche.
2. Cocher "TLS" (URL `rediss://`).
3. Récupérer la `REDIS_URL`.

⚠️ Note : `ioredis` doit accepter le `rediss://` pour TLS. Vérifier dans `packages/queue/src/redis.ts` que la factory ne réécrit pas le protocole. Si un test révèle un souci TLS Upstash spécifique, ajouter `tls: {}` dans les options ioredis.

- [ ] **Step 4 : Créer l'app Fly**

```bash
flyctl apps create vitrine-webhook-demo --org personal
```

(Adapter `--org` au nom d'organisation Fly réel de l'utilisateur.)

- [ ] **Step 5 : Set secrets**

```bash
flyctl secrets set \
  DATABASE_URL="<neon_url>" \
  REDIS_URL="<upstash_url>" \
  MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --app vitrine-webhook-demo
```

⚠️ Note : `MASTER_ENCRYPTION_KEY` est généré une seule fois. Si on le perd ou qu'on le rotate, tous les `secret_encrypted` existants en DB deviennent indéchiffrables (le worker fail). Conserver une copie privée hors-repo.

- [ ] **Step 6 : Premier deploy manuel pour valider**

```bash
flyctl deploy --app vitrine-webhook-demo
```

Expected : build, push, release_command exécute le push Drizzle, puis l'API démarre. À la fin, `flyctl status` doit montrer `api` et `worker` en `running`.

- [ ] **Step 7 : Vérifier l'URL publique**

```bash
flyctl apps list
flyctl info --app vitrine-webhook-demo
APP_URL=https://vitrine-webhook-demo.fly.dev
curl -s "$APP_URL/ready"
```

Expected : `{"ok":true}`.

- [ ] **Step 8 : Créer un client réel et pousser un event smoke**

```bash
# Connecter à Postgres Neon directement pour seed
DATABASE_URL="<neon_url>" pnpm cli:create-client --name fly-smoke
# → noter cl_secret_xxx

curl -s -X POST "$APP_URL/endpoints" \
  -H "Authorization: Bearer cl_secret_xxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/post"}'
# → noter ep_xxx + secret

curl -s -X POST "$APP_URL/events" \
  -H "Authorization: Bearer cl_secret_xxx" \
  -H "Idempotency-Key: fly-smoke-1" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_id":"ep_xxx","event_type":"smoke.test","payload":{"hello":"fly"}}'

sleep 5
curl -s "$APP_URL/events/evt_xxx" -H "Authorization: Bearer cl_secret_xxx"
# → status: "delivered"
```

Expected : `delivered`. Si `pending`, debug via `flyctl logs --app vitrine-webhook-demo` et fixer.

- [ ] **Step 9 : Noter l'URL publique pour le README**

Stocker `https://vitrine-webhook-demo.fly.dev` (ou variante) dans une note locale ; sera embarqué dans le README à la Phase G.

---

### Task F.3 — Workflow `deploy.yml` (CD sur push main)

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1 : Écrire le fichier**

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

⚠️ Note : `--remote-only` délègue le build à Fly's builder (évite de payer le build en GitHub Actions). `concurrency.cancel-in-progress: false` empêche d'annuler un deploy en cours si un nouveau commit arrive (préserve la durabilité du release_command).

- [ ] **Step 2 : Provisionner le secret GitHub**

Manuel : sur GitHub → repo Settings → Secrets and variables → Actions → New repository secret → `FLY_API_TOKEN` = sortie de `flyctl auth token`.

```bash
flyctl auth token
```

Copier la valeur, la coller dans GitHub Secrets.

- [ ] **Step 3 : Commit + push pour déclencher**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add Fly deploy workflow on push to main"
git push origin HEAD
```

Observer dans GitHub Actions que `Deploy` tourne et finit vert. Vérifier dans Fly que la version a bien été incrémentée :

```bash
flyctl status --app vitrine-webhook-demo
```

---

### Task F.4 — Activer la branch protection et valider le flow CI complet

⚠️ Manuel, pas de commit.

- [ ] **Step 1 : Créer une PR factice**

```bash
git checkout -b ci-smoke
echo "" >> README.md  # noop diff
git commit -am "chore: trigger CI"
git push origin ci-smoke
gh pr create --title "ci: smoke" --body "Trigger CI workflows" --base main --head ci-smoke
```

- [ ] **Step 2 : Observer**

Le workflow `CI` doit tourner sur la PR. Vérifier que les 4 steps (typecheck, lint, unit, integration) passent.

- [ ] **Step 3 : Merger**

Si vert, merge la PR. Le workflow `Deploy` doit alors se déclencher et redeploy Fly.

- [ ] **Step 4 : Cleanup**

```bash
git checkout main
git pull
git branch -D ci-smoke
```

---

## Phase G — README polish + chaos PNG embed

### Task G.1 — Ajouter section déploiement + lien live + badge CI

**Files:**
- Modify: `README.md`

- [ ] **Step 1 : Lire le README existant pour caler les modifications**

```bash
cat README.md
```

- [ ] **Step 2 : Modifier le top du README pour ajouter le badge et l'URL live**

Remplacer le bloc d'introduction (les premières lignes du README) par :

```markdown
# Webhook Delivery Service

[![CI](https://github.com/<USER>/<REPO>/actions/workflows/ci.yml/badge.svg)](https://github.com/<USER>/<REPO>/actions/workflows/ci.yml)

Service Node/TypeScript qui ingère des événements via une API HTTP et les livre à des endpoints clients tiers, avec retry exponentiel, circuit breaker, idempotency keys et replay manuel. Modèle d'API aligné sur [Standard Webhooks](https://www.standardwebhooks.com).

> Projet vitrine. Pas un service de production utilisé par de vrais clients.

**Live demo** : https://vitrine-webhook-demo.fly.dev/ready (Fly.io single region `cdg` + Neon Postgres + Upstash Redis).
```

⚠️ Substituer `<USER>` et `<REPO>` par les valeurs réelles GitHub. Substituer l'URL Fly réelle si différente.

- [ ] **Step 3 : Ajouter une section "Chaos demo" après "Tests"**

Identifier la ligne du dernier `## Tests` et insérer après :

```markdown
## Chaos demo

Le script `pnpm demo:chaos` orchestre une démo end-to-end qui :

1. spawn un fake endpoint local scénarisé en 4 phases (200 OK → 500 → 50/50 → 200 OK) ;
2. boote un stack Postgres + Redis + API + Worker via `docker-compose.demo.yml` ;
3. push 100 events sur 5 s, sample l'état du système à 1 Hz pendant ~140 s ;
4. génère un PNG annoté dans `docs/chaos-runs/`.

```bash
pnpm demo:chaos
```

Le run prend ~3 min. Le PNG illustre la mécanique du circuit breaker : ouverture pendant la phase de panne, transition `half_open` après le cooldown, retour à `closed` à la reprise.

### Dernier run

![Latest chaos run](docs/chaos-runs/<FILE_STEM>.png)
```

⚠️ Substituer `<FILE_STEM>` par le nom de fichier (sans extension) du PNG produit en Task D.3, par exemple `2026-05-10-14-32`.

- [ ] **Step 4 : Ajouter une section "Déploiement"**

Avant la section `## Plan d'implémentation`, insérer :

```markdown
## Déploiement

Image Docker multi-stage (`docker/Dockerfile`) commune à l'API et au Worker. Topologie Fly : un seul app avec deux process groups (`api` exposé HTTP, `worker` background).

```bash
flyctl deploy --app vitrine-webhook-demo
```

Migrations Drizzle exécutées automatiquement avant chaque release via `release_command` dans `fly.toml`. Secrets gérés par `flyctl secrets set` (`DATABASE_URL`, `REDIS_URL`, `MASTER_ENCRYPTION_KEY`).

CD configurée : push to `main` déclenche `.github/workflows/deploy.yml` qui appelle `flyctl deploy --remote-only`.
```

- [ ] **Step 5 : Mettre à jour la structure repo en bas du README**

Dans la section `## Structure du repo`, ajouter les nouveaux dossiers :

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
  cli/                        # CLI utilitaires (create-client)
  chaos/                      # demo:chaos (orchestrator + fake endpoint + PNG)
docker/Dockerfile             # image multi-stage API + Worker
docker-compose.yml            # dev local (Postgres + Redis)
docker-compose.demo.yml       # chaos demo stack (build l'image)
fly.toml                      # déploiement Fly (api + worker process groups)
.github/workflows/            # ci.yml + deploy.yml
tests/integration/            # 16 tests Testcontainers
docs/superpowers/             # specs et plans
docs/chaos-runs/              # PNG du dernier run chaos
```

- [ ] **Step 6 : Vérifier le rendu**

```bash
cat README.md | head -30
grep -c "fly.dev" README.md  # > 0 attendu
grep -c "docs/chaos-runs/" README.md  # > 0 attendu
```

- [ ] **Step 7 : Commit avec le PNG du chaos run**

```bash
git add README.md docs/chaos-runs/*.png
git commit -m "docs: embed chaos PNG, add live URL and CI badge to README"
```

---

### Task G.2 — Documenter le critère "Out of scope V1" verbatim depuis le spec

Le spec section 1 demande explicitement que cette section soit reproduite verbatim. Plan 1 a livré une version courte ; on la garde mais on ajoute un lien explicite vers la section 10 du spec qui contient la liste verbatim. Vérifier que le README pointe bien là.

**Files:**
- Modify: `README.md` (idempotent)

- [ ] **Step 1 : Vérifier que le lien existe**

```bash
grep -n "section 10" README.md
```

Expected : au moins une occurrence dans la section "Out of scope V1".

- [ ] **Step 2 : Si absent, l'ajouter**

Sinon, dans la section `## Out of scope V1`, vérifier qu'on a quelque chose comme :

> Voir [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md) section 10 pour la liste exhaustive.

- [ ] **Step 3 : Pas de commit séparé si rien à modifier**

Si une modif a été faite :

```bash
git add README.md
git commit -m "docs: link verbatim out-of-scope section in spec from README"
```

---

### Task G.3 — Vérification finale du critère de fin (Definition of Done V1)

⚠️ Tâche de validation, pas de code.

Reprendre le spec section 1 ("Critères de fin V1") point par point :

- [ ] **Routes API spécifiées section 3** → vérifier en lisant `apps/api/src/routes/` que toutes les routes du spec sont présentes (devrait être OK depuis Plan 1).
- [ ] **Suite de tests unit + integration verte** :

```bash
pnpm test:unit && pnpm test:integration
```

Expected : tous verts.

- [ ] **`pnpm demo:chaos` end-to-end + PNG dans `docs/chaos-runs/`** :

```bash
ls docs/chaos-runs/*.png
```

Expected : au moins un PNG.

- [ ] **Service déployé sur Fly.io accessible via URL publique** :

```bash
curl -s https://vitrine-webhook-demo.fly.dev/ready
```

Expected : `{"ok":true}`.

- [ ] **README** : description, lien Standard Webhooks, run local, PNG embed, section "Out of scope V1" → vérification visuelle de `README.md`.

- [ ] **CI verte sur main** :

```bash
gh run list --workflow ci.yml --branch main --limit 3
```

Expected : tous `completed` `success`.

- [ ] **Step finale : Commit récapitulatif (rien si tout est déjà committé)**

Si une dérive est détectée, fix + commit. Sinon : tag de fin de plan facultatif :

```bash
git tag v1.0.0-vitrine-m6
```

---

## Self-review

Le rédacteur de ce plan se relit :

**Spec coverage** :
- Section 1 (objectifs, critère de fin V1)
  - "Toutes les routes API implémentées" → couvert par Plan 1, vérifié en G.3 ✓
  - "Suite tests unit+integration verte" → vérifié en E.1 (CI) et G.3 ✓
  - "Chaos script + PNG dans docs/chaos-runs/" → Phases B + C + D.3 ✓
  - "Déployé Fly.io URL publique" → Phase F ✓
  - "README" → Phase G ✓
  - "CI verte sur main" → Phase E ✓
- Section 7.3 (chaos demo) → Phases B + C ✓
- Section 7.4 (CI) → Phase E ✓
- Section 9 (déploiement) → Phases D + F ✓

**Placeholder scan** :
- "TBD" / "TODO" : aucun.
- "Add appropriate error handling" : aucun. Les erreurs sont explicites (try/catch dans `bootChaosStack.teardown`, `pushEvents` warn sur status non-2xx).
- "Similar to Task N" : non utilisé. Chaque task répète son code.
- ⚠️ Notes utilisées comme garde-fous (pas placeholders) : compose ↔ Dockerfile pairing en C.1, host.docker.internal Linux en C.4, `--prod=false` justifié en D.1, `MASTER_ENCRYPTION_KEY` non rotatable en F.2.5.

**Type consistency** :
- `Sample` défini en C.2, consommé en C.3 et C.5 ✓
- `PhaseConfig` / `CHAOS_PHASES` définis en B.1, consommés en C.5 ✓
- `ChaosStack` défini en C.4, consommé en C.5 ✓
- `bootChaosStack({ endpointUrl })` cohérent entre C.4 et C.5 ✓
- `seedClient` / `seedEndpoint` viennent de `@vitrine/test-helpers` (Plan 1) — interface compatible avec `seedClient(db, { name })` qui retourne `{ clientId, apiKey }`, et `seedEndpoint(db, { clientId, url, masterKey })` qui retourne `{ endpointId, secret }`. Cohérent avec la signature actuelle dans le repo (vérifié) ✓
- `apiBaseUrl` / `apiKey` / `endpointId` cohérents entre orchestrator et runner ✓
- Script `start` de l'API/Worker cohérent entre D.1 (modif package.json) et docker-compose.demo.yml C.1 (`pnpm --filter ... start`) et fly.toml F.1 (`pnpm --filter ... start`) ✓

**Issues fixed inline** :
- C.3 initialement utilisait `chartjs-plugin-annotation` ; remplacé par un dataset bar empilé semi-transparent pour rester sans dépendance fragile.
- D.1 initialement utilisait `tsc --build` puis `node dist/server.js` ; switch décidé pour tsx en runtime (cohérence avec `packages/*/src/index.ts` exportant du TS direct).
- F.1 initialement deux fly apps distinctes ; consolidé en un seul app avec processes groups après lecture du spec section 9 qui autorise les deux.

---

## Plan complete and saved

`docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-chaos-deploy.md`

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent par task, review entre tasks, fast iteration.

**2. Inline Execution** — exécute les tasks dans cette session via executing-plans, batch execution avec checkpoints.

Lequel ?
