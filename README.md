# Seat Reservation at Scale

A JSON API that sells assigned seats for an event and stays correct under an on-sale stampede: **a seat is never sold twice, a user never exceeds their limit, a retried request never books twice, and declines are clean 4xx, never 5xx**. Built for the Paytm Money "Deploy & Observe" take-home.


| What | Where |
|------|-------|
| Live service | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/) |
| Swagger UI | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/docs](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/docs) |
| Prometheus metrics | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/metrics](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/metrics) |
| Health | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/health/liveness](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/health/liveness) |
| Live logs under load (recording) | [Video Link (GDrive)](https://drive.google.com/file/d/1rVZ9gJ8ZP9rxxThr988gRFz7azIfAum9/view?usp=sharing) |
| Design write-up | [`WRITEUP.md`](WRITEUP.md) |
| Full technical documentation | [`docs/PROJECT_DOCUMENTATION.md`](docs/PROJECT_DOCUMENTATION.md) |

## How it works (short version)

- **One atomic database call per booking.** Every hold or reserve is a single call to the PL/pgSQL function `claim_seats()` (`src/show/reserve-seats.sql.ts`), one implicit transaction:
    1. a per-(show, user) advisory lock;
    2. the idempotency check;
    3. the per-user limit;
    4. `SELECT … FOR UPDATE NOWAIT` on seats that are still free, in seat order;
    5. the writes.

  Multi-seat requests are all-or-nothing. A loser never gets a second copy of a seat: it gets 409.
- **Seat states:** `AVAILABLE` → `HOLD` (lapses at `held_until`) → `RESERVED` (permanent unless its owner cancels). `GET /shows/:id` reports them as `available` / `held` / `confirmed`, and `available + held + confirmed == total_seats` always holds.
- **Idempotency:** a unique `(user_id, idempotency_key)` plus a hash of the request. A retry returns the original 201; the same key with a different body gets 409.
- **Built for stampedes:**
    - hot-seat losers are answered 409 from an in-memory seat cache;
    - a FIFO claim queue protects the connection pool;
    - transient database errors are retried (safe thanks to idempotency);
    - any infrastructure failure becomes 429 with `Retry-After`, never a 500.
- **Stack:** NestJS 12 on Fastify, TypeORM, PostgreSQL, Prometheus metrics (also pushed over OpenTelemetry to Traceway), pino structured logs with an `x-request-id` correlation id.

## Run it locally

Requirements: Node.js 24, pnpm (version pinned in `package.json`, `corepack enable` picks it up), Docker.

### With Traceway Observability (Recommended)

The stack includes Traceway for distributed tracing, metrics, and logs. To get the Traceway ingestion secret, you must start Traceway first, retrieve the token from its UI, then start the API.

```bash
# 1. Start infrastructure (PostgreSQL, Traceway, ClickHouse) — everything EXCEPT the API
docker compose up -d db traceway clickhouse postgres

# 2. Wait for Traceway to be ready, then open http://localhost:4200
#    - Sign in / create an account if prompted
#    - Go to Settings → Ingestion Tokens (or similar)
#    - Copy the **Ingestion Secret / Token**

# 3. Create .env with the Traceway secret
cat > .env <<'ENV'
NODE_ENV=development
PORT=8080
JWT_SECRET=local-dev-jwt-secret-change-me-0123456789
ADMIN_KEY=local-dev-admin-key-change-me-0123456789
LOG_LEVEL=info
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=booking
DB_PASSWORD=booking
DB_DATABASE=booking
DB_SSL=false
DB_MAX_CONNECTIONS=10
SEAT_LOCK_EXPIRATION_MINUTES=10
TRACEWAY_URL=http://localhost:4200
TRACEWAY_SECRET=<paste-your-traceway-ingestion-secret-here>
ENV

# 4. Install, build, and start the API
pnpm install
pnpm build
pnpm start:prod        # or: pnpm start:dev
```

The tables are created on startup (TypeORM `synchronize`), and the `claim_seats()` / `cancel_reservation()` functions are installed automatically. Open `http://localhost:8080/docs` for Swagger, then run a burst against it:

```bash
ADMIN_KEY=local-dev-admin-key-change-me-0123456789 ./burst.sh http://localhost:8080
```

### Without Traceway (Simpler)

If you don't need Traceway observability, you can skip it entirely:

```bash
# 1. Start only the database
docker compose up -d db

# 2. Configuration (no TRACEWAY_* variables needed)
cat > .env <<'ENV'
NODE_ENV=development
PORT=8080
JWT_SECRET=local-dev-jwt-secret-change-me-0123456789
ADMIN_KEY=local-dev-admin-key-change-me-0123456789
LOG_LEVEL=info
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=booking
DB_PASSWORD=booking
DB_DATABASE=booking
DB_SSL=false
DB_MAX_CONNECTIONS=10
SEAT_LOCK_EXPIRATION_MINUTES=10
ENV

# 3. Install, build, start
pnpm install
pnpm build
pnpm start:prod        # or: pnpm start:dev
```

**Docker (all-in-one, with Traceway):** After obtaining the Traceway secret and adding it to `.env`, you can run the full stack including the API:

```bash
docker compose up -d
```

The API will be available at `http://localhost:3000` (container port 3000) and Traceway at `http://localhost:4200`.

### Configuration

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `NODE_ENV` | | `development` | `development` (pretty logs) or `production` (JSON logs) |
| `PORT` | | `3000` | HTTP port |
| `JWT_SECRET` | yes | | 32-256 characters; signs user and admin tokens |
| `ADMIN_KEY` | yes | | 32-256 characters; exchanged for an admin token at `POST /user/admin-token` (`x-admin-key` header) |
| `LOG_LEVEL` | | `DEBUG` | Set it explicitly, lowercase (`info`, `debug`, `warn`) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | yes | | PostgreSQL connection |
| `DB_SSL` | yes (may be empty) | | Any non-empty value enables TLS. Set it but leave it **empty** (`DB_SSL=`) to disable: even the string `false` counts as enabled |
| `DB_MAX_CONNECTIONS` | yes | | Connection pool size (also the claim queue's slots). Keep it well below the database's `max_connections` |
| `SEAT_LOCK_EXPIRATION_MINUTES` | | `10` | How long a hold lasts. Fractions allowed (`0.5` = 30s, handy for testing expiry) |
| `TRACEWAY_URL`, `TRACEWAY_SECRET` | | `http://localhost:4200` | OpenTelemetry (OTLP) destination for traces, metrics and logs |

## Deployment

- **Platform:** Azure Container Apps, built and deployed by `.github/workflows/event-bookings-AutoDeployTrigger-*.yml` on every push to `main`.
- **Shape:** one replica (the seat cache, the claim queue and the `/metrics` counters are per instance), with a pool of `DB_MAX_CONNECTIONS` connections to PostgreSQL. <!-- TODO: database provider/region, e.g. Neon (Azure <region>) -->
- **Probes:** point the readiness probe at `/health/readiness`. It fails closed when the database is unreachable, stays ready when the database is merely busy, and returns 503 while shutting down.
- **Shutdown is graceful:** in-flight requests finish, the pool closes and telemetry is flushed, within 25s.
- **Burst test after each deploy:** `.github/workflows/burst.yml` runs `./burst.sh` against the live URL (secrets `BURST_BASE_URL`, `BURST_ADMIN_KEY`).

## Burst test (one command)

Reproduces the on-sale stampede against any running instance, using only its public API. You need two things: the base URL and the admin key (provided with the submission). No database credentials or JWT secret are needed.

```bash
pnpm install
ADMIN_KEY=<admin key> ./burst.sh https://<live-url>
```

Each scenario runs on a fresh show and prints its outcome distribution (status + reason), latency, the reconciliation from `GET /shows/:id`, and the `/metrics` deltas, then `PASS`/`FAIL`:

| Scenario | What it fires | Must hold |
|----------|---------------|-----------|
| `stampede` (N=2000) | ~30% storm 5 hot seats, ~60% take distinct seats, ~10% resend an earlier request's exact key and body | exactly one winner per hot seat (losers get 409), every distinct seat confirmed, each retry returns its original reservation, zero 5xx |
| `hot` (N=500) | 500 users racing for one seat | exactly one 201, 499 × 409 |
| `limit` | one user, 10 parallel reserves, `per_user_limit=4` | exactly 4 succeed |
| `idem` | one user, the same idempotency key 50 times | one reservation, every response returns it |
| `cancel` | reserve → another user tries the seat → another user tries to cancel → the owner cancels (twice) → the other user reserves | 409, 404, 200 (seat released), 200 (nothing released), 201: only the owner can cancel and a released seat is re-bookable |
| `expiry` (opt-in: `EXPIRY=1`) | A holds A1+A2 → B is locked out → A reserves A1 → wait past `held_until` → B reserves A2 → A cancels the old hold | while held: 409 for B, A's own hold converts to a reservation; after expiry: A2 is `available` and re-bookable, A1 stays `confirmed`; the late cancel releases nothing. Waits for the server's hold TTL (`SEAT_LOCK_EXPIRATION_MINUTES`, default 10 min), so set it low (e.g. `0.5`) on the server for a quick run |

All scenarios also check `available + held + confirmed == total_seats` and that no seat or idempotency key maps to more than one reservation. The script exits non-zero if anything failed. Sizes can be changed with `N`, `HOT_N`, `CONCURRENCY` and `TIMEOUT_MS`, e.g. `N=20000 ./burst.sh <url>`.

One scenario at a time: `pnpm load:reserve --url <url> --mode stampede -n 2000` (with `ADMIN_KEY` set). Add `--db-check` locally to also verify the tables directly (needs the `DB_*` variables).

**Proof of a real run:** `.github/workflows/burst.yml` runs `./burst.sh` against the live URL after every successful deployment (and on demand from the Actions tab), using the `BURST_BASE_URL` and `BURST_ADMIN_KEY` repository secrets. Its log and step summary are public. Latest run: <!-- TODO: link to the Actions run -->

**How it gets users:** `POST /user/test-tokens` (admin token required) creates or reuses up to 20,000 users named `<prefix>_00001`, … and returns a user token for each, without per-user password hashing. Get an admin token from `POST /user/admin-token` with the `x-admin-key` header. You can use both for your own load tests.

## API at a glance

| Method | Path | Auth | What it does |
|--------|------|------|--------------|
| POST | `/shows` | admin | Create a show (1-50,000 seats, all available). Returns it with its `id`. |
| GET | `/shows/:id` | public | Per-seat status (`available` / `held` / `confirmed`), `counts`, `total_seats`. |
| POST | `/shows/:id/hold` | user | Temporarily hold seats until `held_until`; the hold lapses on its own. |
| POST | `/shows/:id/reserve` | user | Reserve seats for good (free seats, or seats you hold). 201 `status: "confirmed"`. |
| POST | `/reservations/:id/cancel` | user (owner) | Release your hold or reservation; its seats become available again. |
| POST | `/user/admin-token` | `x-admin-key` | Admin token. |
| POST | `/user/register`, `/user/login` | public | User account and token. |
| POST | `/user/test-tokens` | admin | Up to 20,000 test users with tokens, for load tests. |
| GET | `/health/liveness`, `/health/readiness` | public | Liveness; readiness checks the database (busy still counts as ready) and fails closed. |
| GET | `/metrics` | public | Prometheus metrics. |
| GET | `/docs` | public | Swagger UI. |

**Limits:** a show has at most **50,000 seats** (`GET /shows/:id` returns every seat, so this keeps that response around 2 MB); request bodies are capped at 2 MB. A hold or reserve names 1-10 seats. `per_user_limit` defaults to 4.

**Correlation id:** every response carries an `x-request-id` header. Send your own (`[A-Za-z0-9._-]`, up to 128 characters) to have it reused; otherwise a UUID is generated. The same id appears on every log line of that request (`req.id`).

## Observability: Prometheus metrics

Metrics are served at **`GET /metrics`** (Prometheus text format). Scrapes themselves are not counted in the HTTP metrics. The same custom metrics are also pushed to Traceway over OTLP every 10s (`src/metrics/prom-client-producer.ts`); `/metrics` is the live source of truth.

| Metric | Type | Labels | What it shows |
|--------|------|--------|---------------|
| `http_requests_total` | counter | `method`, `route`, `status_code` | Every response, by route template (e.g. `/shows/:id/reserve`) and status: 5xx, 409, 429 counts. |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Response latency (p50/p95/p99). |
| `http_responses_total` | counter | `status_class` (`2xx`, `3xx`, `4xx`, `5xx`) | Every response by status class. `5xx` exists (at 0) from startup, so a zero-5xx widget can filter on it. |
| `http_requests_in_flight` | gauge | | Requests being processed right now. |
| `reservations_confirmed_total` | counter | | Successful `POST /shows/:id/reserve`. |
| `holds_created_total` | counter | | Successful `POST /shows/:id/hold`. |
| `reservations_cancelled_total` | counter | `kind` (`hold`, `reserve`) | Holds/reservations cancelled by their owner. |
| `seats_released_total` | counter | | Seats returned to available by cancellations. |
| `reservations_declined_total` | counter | `reason`, `action` | Claims that created nothing: `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_mismatch`, `request_in_progress`, `server_busy`; `action` is `hold` or `reserve`. |
| `seats_available` / `seats_held` / `seats_confirmed` / `seats_total` | gauge | `show_id` | Seat state of the 50 newest shows, read from the database at scrape time with the same rules as `GET /shows/:id` (an expired hold counts as available). |
| `db_up` | gauge | | 1 if the database answered the last scrape-time query. |
| `db_pool_connections` | gauge | `state` (`total`, `idle`, `waiting`) | Database connection pool usage. |
| `db_errors_total` | counter | `reason`, `code` | Database/infrastructure errors turned into deliberate responses (`SERVER_BUSY`, `DB_UNAVAILABLE`, ...) with their SQLSTATE / Node error code. |
| `unhandled_errors_total` | counter | | Errors nothing could classify (answered 500). Should stay 0. |
| `claim_seats_duration_seconds` | histogram | `action`, `outcome` | Time spent in the single `claim_seats()` database call. |
| `claim_queue_waiting` | gauge | | Hold/reserve requests waiting for a database slot. |
| `claim_queue_wait_seconds` | histogram | `action` | How long they waited. |
| `seat_cache_rejections_total` | counter | `stage` | Hot-seat losers answered 409 from memory without touching the database. |
| `claim_retries_total` | counter | `action` (`hold`, `reserve`, `cancel`), `reason`, `outcome` (`recovered`, `exhausted`) | Database calls that hit a transient error (connection dropped, briefly overloaded) and were retried; `recovered` means the request still succeeded. |

Labelled counters start with every label value at 0 (`src/metrics/metrics-initializer.ts`): every decline `reason` × `action`, every `status_class`, every retry `action` × `reason` × `outcome`, every cache `stage`, every cancel `kind`, and every `db_errors_total` `reason` (with `code="none"`). Dashboards can filter and group by them before the first event, and they read 0 until it happens.

Default Node.js process metrics (CPU, memory, event-loop lag, ...) are exported too.

**Useful queries during a burst**

```promql
# zero 5xx
sum(http_requests_total{status_code=~"5.."})

# responses to the reserve endpoint by status
sum by (status_code) (http_requests_total{route="/shows/:id/reserve"})

# declines by reason
sum by (reason, action) (reservations_declined_total)

# p99 latency of reserves
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{route="/shows/:id/reserve"}[1m])))

# reconciliation: must be 0 for every show
seats_total - (seats_available + seats_held + seats_confirmed)
```

**How the numbers reconcile for `/shows/:id/reserve`:**
- 201 responses = `reservations_confirmed_total` + `reservations_declined_total{reason="idempotent_replay",action="reserve"}`.
- 409 responses = `reservations_declined_total{action="reserve"}` for `seat_taken` + `per_user_limit` + `idempotency_mismatch` + `request_in_progress`.
- `seats_confirmed{show_id}` = `counts.confirmed` from `GET /shows/:id`.

## Project layout

```
src/
  show/            shows, holds, reservations, cancel; claim_seats()/cancel_reservation() SQL, seat cache
  user/            register, login, admin token, test users for load tests
  auth/            JWT strategy (token-only identity), roles guard
  health/          liveness / readiness
  metrics/         Prometheus metrics, HTTP hooks, seat-state gauges, OTLP bridge to Traceway
  common/          global exception filter, DB error classification, request id, shutdown, pool warm-up
  instrumentation.ts   OpenTelemetry SDK (traces, metrics, logs)
scripts/load-reserve.ts  load / correctness scenarios (API only)
burst.sh                 one-command burst against any URL
WRITEUP.md               design write-up
docs/PROJECT_DOCUMENTATION.md   full technical documentation
```

## License

GPL-3.0, see [`LICENSE`](LICENSE).