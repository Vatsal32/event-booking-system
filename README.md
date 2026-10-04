<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

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

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observe](https://observe.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
