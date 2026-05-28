# Webhook Delivery Service

[![CI](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml/badge.svg)](https://github.com/KevinLmn/webhook-delivery-service/actions/workflows/ci.yml)

Service Node/TypeScript qui ingère des événements via une API HTTP et les livre à des endpoints clients tiers, avec retry exponentiel, circuit breaker, idempotency keys et replay manuel. Modèle d'API aligné sur [Standard Webhooks](https://www.standardwebhooks.com).

> Projet vitrine. Pas un service de production utilisé par de vrais clients.

**Live demo** : https://vitrine-webhook-demo.fly.dev/ready (Fly.io single region `cdg` + Neon Postgres + Upstash Redis).

## Fonctionnalités V1

- API multi-tenant Fastify avec auth Bearer (argon2id).
- Idempotency keys obligatoires (Redis, TTL 24h).
- Worker BullMQ avec retry exponentiel (1s → 10s → 1min → 10min → 1h → 6h, 7 attempts max).
- Circuit breaker partagé (state machine atomique en Lua).
- Signature HMAC Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
- Secrets chiffrés au repos (AES-256-GCM, master key séparée).
- Replay single-event.
- Tests d'intégration avec Testcontainers (Postgres + Redis).

### Note d'interopérabilité Standard Webhooks

L'implémentation suit la **forme** Standard Webhooks (signed string `id.timestamp.body`, headers `webhook-*`, scheme `v1,<base64>`), mais utilise le secret **en UTF-8 brut** comme clé HMAC. La variante Svix décode le secret en base64 après strip du préfixe `whsec_` avant HMAC. Les consommateurs Svix bit-for-bit ne valideront donc pas nos signatures sans adapter leur clé HMAC. Le format de header et la chaîne signée restent compatibles.

## Out of scope V1

Voir [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md) section 10. En particulier : pas de signup public, pas de rotation de secret endpoint, pas de batch replay, pas d'observabilité prod-grade, pas de SDK clients, pas de port Rust (autre spec), pas de dashboard (autre spec), pas d'AWS (autre spec).

## Run local

Pré-requis : Node 22 LTS, pnpm 9, Docker Compose.

```bash
nvm use
pnpm install

# infra locale (Postgres + Redis)
docker compose up -d

# migrations
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine pnpm db:push

# créer un client (note l'API key, affichée une seule fois)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine \
  pnpm cli:create-client --name local

# .env (cf. .env.example)
cp .env.example .env
# remplir MASTER_ENCRYPTION_KEY = $(openssl rand -base64 32)

# lancer API + Worker en parallèle
pnpm dev
```

### Smoke test end-to-end

Une fois `pnpm dev` lancé, dans un autre terminal :

```bash
API_KEY=cl_secret_...  # depuis cli:create-client

# créer un endpoint
curl -s -X POST http://localhost:3000/endpoints \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://httpbin.org/post"}'
# → noter ep_xxx

# pousser un event
curl -s -X POST http://localhost:3000/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Idempotency-Key: smoke-1" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_id":"ep_xxx","event_type":"smoke.test","payload":{"hello":"world"}}'

# vérifier le status après ~5s
curl -s http://localhost:3000/events/evt_xxx -H "Authorization: Bearer $API_KEY"
# → status: "delivered"
```

## Tests

```bash
pnpm test:unit           # tests unitaires (packages), < 5s
pnpm test:integration    # 16 tests d'intégration (Testcontainers Postgres + Redis), ~3 min
```

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

## Architecture

Voir [`docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md`](docs/superpowers/specs/2026-05-09-webhook-delivery-hot-path-design.md).

## Déploiement

Image Docker multi-stage (`docker/Dockerfile`) commune à l'API et au Worker. Topologie Fly : un seul app avec deux process groups (`api` exposé HTTP, `worker` background).

```bash
flyctl deploy --app vitrine-webhook-demo
```

Migrations Drizzle exécutées automatiquement avant chaque release via `release_command` dans `fly.toml`. Secrets gérés par `flyctl secrets set` (`DATABASE_URL`, `REDIS_URL`, `MASTER_ENCRYPTION_KEY`).

CD configurée : push to `main` déclenche `.github/workflows/deploy.yml` qui appelle `flyctl deploy --remote-only`.

## Plan d'implémentation

Voir [`docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md`](docs/superpowers/plans/2026-05-09-webhook-delivery-hot-path-core.md) pour le découpage tâche-par-tâche.

## Structure du repo

```
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
