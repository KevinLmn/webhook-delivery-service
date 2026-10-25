# Niveau suivant : ingest

> **Note d'étude personnelle de Kevin, en français.** Le reste du dépôt est en anglais ; cette note fait le pont entre ce service et le projet suivant, `ingest`. Tous les chiffres viennent des fichiers de résultats du dépôt `ingest` (`bench/results/2026-10-25_pgbench-plafond/`), état au 25/10/2026, avec leur configuration. Quand une phrase est une hypothèse ou une déduction, elle est marquée comme telle.

---

## 1. Ce qu'est ingest

Un même service d'ingestion d'événements, **écrit deux fois** (Node/Fastify et Go), sur **la même base Postgres**, sous **la même charge k6**, sur une machine de banc dédiée (`lab` : Ryzen 9 3950X, NVMe Samsung 970 EVO Plus, Ubuntu 24.04). Domaine : des événements de métriques, façon mini-Datadog (`ts`, `source`, `name`, `value`, `tags`).

La méthode : on mesure, on trouve le goulot, on corrige, on publie l'avant/après. Règles de mesure : percentiles (p50/p95/p99) et pas seulement des moyennes, **une seule variable change entre deux mesures**, échauffement, plusieurs passages, configuration exacte notée à côté de chaque chiffre.

Trois objectifs à la fois :

1. **Node contre Go, par la mesure** : boucle d'événements + pool de threads libuv d'un côté ; ordonnanceur G-M-P, netpoller et préemption de l'autre. Node sur 1 processus, Node en cluster, Go sur 1 processus.
2. **Postgres en profondeur**, le goulot commun : ligne par ligne → par lots → `COPY`, pool de connexions, coût des index à l'écriture, partitionnement, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_statements`, MVCC et vacuum sous forte écriture.
3. **Des chiffres mesurés** à mettre en face de chaque affirmation.

## 2. Comment il prolonge webhook

Le webhook-delivery-service fait exactement ce qu'ingest mesure en premier, sans l'avoir mesuré :

| Dans ce dépôt | Ce que ça coûte en écriture | Équivalent dans le banc ingest |
|---|---|---|
| `POST /events` → `ingestion.ts` : un `INSERT` en autocommit | 1 COMMIT = 1 vidage du WAL sur disque par événement | **lot 1** (`insert_1.sql`) |
| Une tentative de livraison → `deliver.ts` : `INSERT delivery_attempts` + `UPDATE events`, sans transaction | 2 COMMIT par tentative | lot 1, deux fois |
| Aucun regroupement nulle part | — | les lots 100 et 1 000 montrent ce qu'on laisse sur la table |

Autrement dit : le commentaire ajouté dans `packages/db/src/client.ts` (« one INSERT = one COMMIT = one WAL flush ») est la phrase que les chiffres ci-dessous rendent concrète.

Attention à ne pas transposer les chiffres tels quels : webhook tourne sur un VPS, avec un autre disque, et fait aussi un `SET NX` Redis et un `queue.add` BullMQ par événement. Le banc mesure Postgres **seul**, sur `lab`. Ce qui se transpose, c'est le **mécanisme** (coût du COMMIT), pas le nombre.

Ce que ça change pour webhook, si on voulait l'appliquer : mettre `INSERT attempt` + `UPDATE event` dans une seule transaction (1 COMMIT au lieu de 2, et plus de fenêtre incohérente), et, à fort débit, regrouper l'ingestion par lots, ce qui oblige à repenser l'idempotence et l'enqueue (outbox).

## 3. Les résultats pgbench « plafond » (25/10/2026)

### Question posée

Combien d'événements/s Postgres absorbe-t-il sur `lab`, **sans aucun service devant**, selon la taille du lot (1, 100, 1 000 événements par transaction) ?

### Configuration (recopiée de `config.md`)

| | |
|---|---|
| Machine | `lab` : Ryzen 9 3950X (16 c / 32 t), 62 Go RAM (simple canal), NVMe Samsung 970 EVO Plus 1 To, ext4 sur LVM |
| OS | Ubuntu 24.04.5, noyau 6.8.0-147, gouverneur CPU `schedutil`, ordonnanceur I/O NVMe `none` |
| Postgres | 18.6 (`18.6-1.pgdg24.04+2`), **réglages par défaut** |
| Réglages clés | `shared_buffers=128MB`, `wal_buffers=4MB`, `max_wal_size=1GB`, `checkpoint_timeout=5min`, `synchronous_commit=on`, `fsync=on`, `full_page_writes=on`, `wal_compression=off` |
| Table | `db/migrations/001_events.sql` : **aucun index, aucune clé primaire** |
| Client | pgbench 18.6 sur la même machine, `-c 16 -j 8` (16 connexions, 8 threads), sans `taskset` |
| Protocole | `run.sh <lot>` : `TRUNCATE` + `fstrim /`, 30 s d'échauffement jetés, puis 3 × 60 s avec `TRUNCATE` + `fstrim /` avant chacun |
| Données | lignes générées **côté serveur** (`generate_series`) : plafond **optimiste** (ni envoi réseau ni décodage) |

### Résultats retenus (série 3, avec TRIM)

Événements/s = tps × taille du lot.

| Lot | Passage 1 | Passage 2 | Passage 3 | Latence moy. / transaction | Checkpoints / passage de 60 s |
|---:|---:|---:|---:|---:|---:|
| 1 | 8 837 | 8 841 | 8 854 | 1,8 ms (1,807 à 1,811) | 0-1 |
| 100 | 646 665 | 641 956 | 635 610 | 2,5 ms (2,474 à 2,517) | 9-10 |
| 1 000 | 1 434 166 | 1 474 462 | 1 473 494 | 10,9 ms (10,851 à 11,156) | 21-22 |

Brut : `serie-3-avec-trim.txt`. Écart entre passages < 3 %.

### Le pourquoi derrière chaque chiffre

**Lot 1 : ~8,8 k événements/s, et c'est le disque qui décide.**
pgbench est en autocommit : chaque `INSERT` est sa propre transaction, donc chaque événement paie un COMMIT. Avec `synchronous_commit=on`, un COMMIT ne rend la main qu'une fois son enregistrement WAL écrit **et forcé sur disque** (`fdatasync`). Le plafond n'est donc pas une quantité de données, c'est un nombre de vidages du WAL par seconde.

Une vérification utile (déduction, pas une mesure de plus) : avec 16 clients qui enchaînent les transactions sans pause, le débit est simplement *clients / latence* (loi de Little). 16 / 1,811 ms ≈ 8 835 tps, exactement le chiffre mesuré ; 16 / 2,474 ms ≈ 6 467 tps pour le lot 100 ; 16 / 11,156 ms ≈ 1 434 tps pour le lot 1 000. Les tps et la latence moyenne de pgbench ne sont donc pas deux informations indépendantes : pour faire monter le débit à concurrence fixe, il faut faire baisser la latence d'un COMMIT, ou mettre plus d'événements dans chaque COMMIT.

**Lot 100 : ~640 k/s, environ ×73 par rapport au lot 1 pour 100 fois plus de lignes.**
Un seul COMMIT pour 100 lignes : le coût du vidage du WAL est partagé. La latence par transaction ne passe que de 1,8 à 2,5 ms alors que la transaction écrit 100 fois plus de lignes. Ce qui reste à payer : écrire les lignes dans les pages de la table, produire le WAL correspondant, et 9-10 checkpoints par minute.

**Lot 1 000 : ~1,47 M/s, mais seulement ×2,3 par rapport au lot 100 pour un lot 10 fois plus gros.**
Le COMMIT n'est plus le facteur dominant : la latence par transaction est multipliée par ~4,4 (2,5 → 10,9 ms). Le suspect désigné dans `config.md` : **les checkpoints**. 21-22 par passage de 60 s, soit un toutes les ~3 s, parce que le volume de WAL atteint `max_wal_size=1GB` en permanence. Chaque checkpoint force l'écriture de toutes les pages modifiées, et juste après chaque checkpoint, la première modification de chaque page réécrit **la page entière** dans le WAL (`full_page_writes`). Plus les checkpoints sont fréquents, plus le WAL grossit, ce qui rapproche encore le checkpoint suivant. C'est une hypothèse étayée par le compteur, pas encore une preuve : la mesure qui tranche est en §5.

**Tous ces chiffres sont des plafonds optimistes.**
Les lignes sont fabriquées par `generate_series` dans Postgres : pas de réseau, pas de parsing de paramètres, pas de décodage JSON côté application. Un vrai service qui envoie ses lignes fera moins. Et pgbench ne donne que des latences **moyennes** ; les percentiles arriveront avec k6.

## 4. L'enquête du lot 100 : la variable cachée

C'est la partie la plus instructive du banc, parce que la première série était **fausse sans en avoir l'air**.

### Ce qui clochait

Première série, sans TRIM (`serie-1.txt`) :

| Lot | Passage 1 | Passage 2 | Passage 3 |
|---:|---:|---:|---:|
| 1 | 8 802 | 8 808 | 8 774 |
| 100 | 499 554 | 397 687 | 339 105 |
| 1 000 | 1 044 796 | 1 051 986 | 1 039 379 |

Le lot 100 baisse de passage en passage. Relancé (`serie-2-lot100.txt`, NVMe relevé à 59-61 °C) : 260 388 / 245 618 / 243 229. Il n'a pas seulement varié, il est **descendu durablement**.

### Une variable à la fois (`enquete-lot100.md`)

1. **Autovacuum désactivé sur `events`** : 251 625 / 259 315 / 286 744 contre 245 639 / 244 434 / 237 448 en référence. Effet faible. **Écarté.** (Logique : une table en insertion pure n'a pas de lignes mortes à nettoyer.)
2. **Contrôle avec le lot 1**, le plus sensible à la latence de `fdatasync` puisqu'il fait un COMMIT par événement : 8 802 / 8 808 / 8 774 en début de journée, puis **4 685 / 3 095 / 3 126** après environ 70 Go de WAL écrits (estimation notée dans le fichier : 48 Go mesurés + séries suivantes). → **C'est le disque qui a ralenti, pas Postgres.**
3. **Deux hypothèses** : (1) cache SLC du SSD épuisé, qui se vide au repos ; (2) ramasse-miettes du SSD qui travaille sur des blocs que `TRUNCATE` a libérés sans que le SSD le sache (`fstrim.timer` hebdomadaire, ext4 monté sans `discard`).
4. **Repos de 20 min** : 7 006 / 3 107 / 3 122. Le repos ne fait que retarder la chute de 1 à 2 minutes d'écriture. Hypothèse 1 insuffisante.
5. **`sudo fstrim /`** (901 Gio signalés libres) : 8 500 / 8 837 / 8 836. Le TRIM rétablit le débit **et le maintient**. **Cause retenue : hypothèse 2.**

### Le mécanisme, en clair

`TRUNCATE` ne vide pas les fichiers de la table : il en crée de nouveaux et supprime les anciens. ext4 marque ces blocs comme libres, mais **le SSD ne le sait pas** tant qu'on ne lui envoie pas de TRIM. Pour lui, ces pages contiennent encore des données valides. Quand il doit libérer de la place pour écrire, son ramasse-miettes recopie donc ces données mortes, ce qui ajoute des écritures internes et fait monter la latence de chaque `fdatasync`. Le lot 1, qui attend un `fdatasync` par événement, le ressent le plus ; le lot 1 000 le moins.

### Correction et leçon

`run.sh` fait maintenant `TRUNCATE` + `fstrim /` avant chaque passage. Avec ce protocole, le lot 1 000 monte aussi (1,05 M → 1,47 M) : la série 1 tournait déjà sur un disque en train de se dégrader. Et le « bon » chiffre du lot 1 de la série 1 ne l'était que parce que le disque sortait d'une longue inactivité.

La leçon générale : **l'état interne du SSD est une variable du banc**. Sans la remettre à zéro, une mesure dépend de tout ce qui a été écrit avant elle. C'est exactement le genre de piège que la règle « une seule variable à la fois, et vérifier par un contrôle » permet d'attraper.

### Point encore ouvert

Les mesures `pg_test_fsync` ne racontent pas encore une histoire cohérente : `fdatasync` ≈ 1 220 ops/s (819 µs/op) mesuré pendant la dégradation (`enquete-lot100.md`), et 833 ops/s après `fstrim` (`enquete-brut.txt`), alors que le lot 1 est **meilleur** après le TRIM. Deux pistes, à vérifier, pas des conclusions :
- `pg_test_fsync` mesure un seul processus qui écrit et vide en boucle. Postgres, lui, peut regrouper les COMMIT de plusieurs sessions dans un même vidage (*group commit*). 8 837 COMMIT/s pour 833 `fdatasync`/s ferait ~10 COMMIT par vidage en moyenne, si les deux chiffres étaient comparables.
- Les deux mesures n'ont peut-être pas été prises dans les mêmes conditions (même ligne du rapport `pg_test_fsync`, même durée `-s`). À refaire côte à côte avant d'en tirer quoi que ce soit.

## 5. Ordre de lecture des fichiers d'ingest

Le dépôt est jeune : tout se lit en une heure. Dans cet ordre :

1. **`db/migrations/001_events.sql`** : la table, volontairement nue (ni index, ni clé primaire). *À retenir :* chaque index ajouté plus tard sera une variable mesurée à part. *Question :* qu'est-ce qu'une clé primaire ajouterait comme travail à chaque `INSERT` ?
2. **`bench/pgbench/insert_1.sql`** : un événement par transaction. *À retenir :* autocommit, donc un COMMIT et un vidage du WAL par ligne. C'est le chemin d'écriture de webhook aujourd'hui.
3. **`bench/pgbench/insert_100.sql`** puis **`insert_1000.sql`** : un seul COMMIT pour N lignes fabriquées par `generate_series`. *À retenir :* pourquoi c'est un plafond optimiste.
4. **`bench/pgbench/run.sh`** : le protocole en code. *À retenir :* `TRUNCATE` + `fstrim` avant chaque passage, échauffement jeté, 3 passages, compteur de checkpoints avant/après (`pg_stat_checkpointer`), et `événements/s = tps × lot`. Le commentaire sur le TRIM résume l'enquête.
5. **`bench/results/2026-10-25_pgbench-plafond/config.md`** : la configuration complète, les résultats retenus et leur lecture.
6. **`serie-1.txt`** puis **`serie-2-lot100.txt`** : les séries faussées, à lire comme on lit un bug.
7. **`enquete-lot100.md`**, avec **`enquete-brut.txt`** à côté : l'enquête, une variable à la fois.
8. **`serie-3-avec-trim.txt`** : les chiffres retenus, bruts.

## 6. Ce que les prochaines mesures doivent apprendre

Chaque ligne : une question, **la seule variable qui change**, ce qu'on apprend. Pas de prédiction chiffrée : c'est la mesure qui la donnera.

| # | Question | Variable unique | Ce qu'on apprend |
|---|---|---|---|
| 1 | Les checkpoints expliquent-ils le ×2,3 seulement entre lot 100 et lot 1 000 ? | `max_wal_size` (1 GB → plus grand), lot 1 000 | Si le débit monte quand les checkpoints / passage baissent, le suspect est confirmé. Regarder aussi le volume de WAL (`pg_stat_wal.wal_bytes`, `wal_fpi` pour les pages entières). |
| 2 | Combien coûte exactement le COMMIT durable ? | `synchronous_commit=off`, lot 1 | L'écart avec 8,8 k/s mesure le prix du `fdatasync` par COMMIT. À présenter avec son compromis : on peut perdre les dernières transactions validées en cas de crash, sans corruption. |
| 3 | Le *group commit* explique-t-il 8,8 k COMMIT/s ? | aucune ; compter les vidages du WAL pendant un passage du lot 1 | Sur Postgres 18, les compteurs d'écriture et de synchronisation du WAL sont dans `pg_stat_io` (à vérifier dans la doc 18). Rapport COMMIT / vidages. |
| 4 | Que coûte l'envoi réel des données ? | lignes envoyées par le client (`INSERT … VALUES` multi-lignes) au lieu de `generate_series` | La part réseau + parsing que le plafond optimiste cache. |
| 5 | `COPY` fait-il mieux que l'`INSERT` par lots ? | `COPY` à taille de lot égale | Le coût du parsing SQL et du plan par rapport au flux binaire/texte. |
| 6 | Que coûte un index à l'écriture ? | ajout d'un index (puis d'une clé primaire), un à la fois | Écritures supplémentaires par ligne, WAL en plus, effet sur les checkpoints. |
| 7 | Node contre Go devant la même base | le langage du service, même endpoint, même script k6, même taille de lot | Débit et p50/p95/p99, cœurs utilisés, mémoire. Puis Node en cluster. Le moment de voir la boucle d'événements saturer sur le décodage JSON. |
| 8 | Quelle taille de pool de connexions ? | nombre de connexions du pool, service fixé | Au-delà d'un certain nombre, plus de connexions ne donnent plus de débit et font monter la latence. Repérer ce point. |

Ensuite seulement : partitionnement par jour, `EXPLAIN (ANALYZE, BUFFERS)` sur la requête d'agrégation, `pg_stat_statements`, MVCC et vacuum sous forte écriture.

## 7. Le lien à garder en tête

Webhook montre la **fiabilité** (retries, breaker, idempotence, at-least-once). Ingest montre le **débit**, mesuré. Les deux se rejoignent sur une seule ligne de code : un `INSERT` en autocommit par événement. Savoir dire ce que coûte cette ligne sur un vrai disque, pourquoi, et comment on la remplace (lots, `COPY`, transaction unique, outbox), c'est le pont entre les deux projets.
