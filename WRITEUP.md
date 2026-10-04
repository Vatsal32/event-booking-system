# Seat Reservation at Scale: write-up

## Links

| What | Where |
|------|-------|
| Live service | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/) |
| Swagger UI | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/docs](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/docs) |
| Prometheus metrics | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/metrics](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/metrics) |
| Health | [https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/health/liveness](https://event-bookings.purpleglacier-6241d065.centralindia.azurecontainerapps.io/health/liveness) |
| Live logs under load (recording) | [Video Link (GDrive)](https://drive.google.com/file/d/1rVZ9gJ8ZP9rxxThr988gRFz7azIfAum9/view?usp=sharing) |
| Repository | [https://github.com/Vatsal32/event-booking-system/](https://github.com/Vatsal32/event-booking-system/) |

**Stack:**
- NestJS on Fastify, TypeORM and PostgreSQL. A single database is the only system of record: no Redis and no queue.
- Deployed on Azure Container Apps as **one replica** with **10 database connections**; the free-tier database allows 15.
- Prometheus metrics at `/metrics`, also pushed over OTLP to Traceway. Structured pino logs carry a correlation id.

**Run the burst yourself:** `ADMIN_KEY=<key> ./burst.sh <live-url>`. See the README. The admin key is provided with the submission.

---

## 1. The atomic decision

**Mechanism:** every hold or reserve request is **one call to a PL/pgSQL function, `claim_seats()`** (`src/show/reserve-seats.sql.ts`). It runs as one implicit transaction, in one round trip. The decision lives entirely inside Postgres; the API never reads seat state and then writes it.

Inside the function, in this order:

1. **Per-user lock:** `pg_advisory_xact_lock(hash(show, user))`. A single user's requests for a single show run one at a time. Other users never wait on it.
2. **Idempotency check** (section 2).
3. **Per-user limit:** the user's `RESERVED` seats plus unexpired `HOLD` seats for the show, excluding the seats being requested, plus the request size, must not exceed `per_user_limit` (default 4).
   - This count is a **separate statement after the lock.** Under READ COMMITTED each statement takes its snapshot when it starts, and in a VOLATILE function each statement gets a fresh one.
   - So the count sees the commit of whichever request held the lock before. If it were merged into the lock statement, it would read a stale snapshot, and ten parallel requests could all pass a limit of 4.
4. **The seat gate:** `SELECT seat_id … WHERE show_id = $1 AND seat_number = ANY($2) AND <free> ORDER BY seat_number FOR UPDATE NOWAIT`.
   - "Free" means `AVAILABLE`, or a `HOLD` whose `held_until` has passed. For `/reserve`, it also includes the caller's own unexpired hold.
   - A seat someone else holds or has reserved doesn't match, so it isn't returned and nothing is locked. A free seat that another in-flight request has locked raises `55P03` immediately (`NOWAIT`); nobody queues behind a hot row.
   - If fewer rows come back than were requested, the request is declined with 409 `SEAT_TAKEN`, **before anything is written**.
5. **Write:** insert the reservation row, then update all the locked seats.

**Why it's race-free:**
- The check ("is A12 free?") and the take are the same locked statement, so two requests can't both see A12 as free and both take it.
- The loser either fails to match the row after the winner commits, or gets `55P03` while the winner is mid-transaction. Either way it gets a clean 409.
- `(show_id, seat_number)` is unique, so a seat is a single row that can only have one owner.

**Multi-seat requests: all-or-nothing.** If any requested seat isn't free, nothing is written and the whole request gets 409. That's my answer to the spec's "partial requests" question; best-effort would let a buyer end up with half a group booking.

**Deadlock avoidance:** every path takes locks in the same order: the per-(show, user) advisory lock, then seat rows sorted by `seat_number`, then the reservation row. `claim_seats()` and `cancel_reservation()` both follow it. Combined with `NOWAIT` on the seat gate and a 1s `lock_timeout`, a lock cycle can't form, and no request waits long.

**Known trade-off of `NOWAIT`:** if the winner's transaction rolls back, a loser that hit `55P03` was told 409 for a seat that ended up free. I chose that over making a storm of losers queue on the row lock.

## 2. Idempotency

- **Where the key lives:** the `reservations` table, one row per successful hold or reserve, with a **unique index on `(user_id, idempotency_key)`**. Keys are scoped to the token's user, so one user's key can never return another user's reservation.
- **How it's sent:** the `idempotency_key` body field (the spec's name), the `idempotencyKey` body field, or an `Idempotency-Key` header. Any one of them; 1–100 characters. Sending the same key in several places is fine; two different keys, or none, gets 400.
- **Exactly once:**
  - Step 2 of `claim_seats()` looks the key up after taking the per-user lock. A retry, even one sent in parallel, waits for the first attempt to commit, finds its row, and returns `REPLAY`.
  - The unique index is the backstop. If the same key is used on two different shows at the same moment (two different advisory locks), the second insert hits `23505`. The service calls once more, and gets `REPLAY` or `IDEMPOTENCY_MISMATCH`.
- **Replay:** returns the original **201 with the same body**, from columns stored on the row (`seat_numbers`, `amount_paise`, `expires_at`). It doesn't depend on the seats' current state.
- **Same key, different body → 409 `IDEMPOTENCY_KEY_MISMATCH`.**
  - The row stores `request_hash = sha256(mode : show_id : sorted seats)`. A different seat set, a different show, or using a `/hold` key on `/reserve` all mismatch.
  - Seat order doesn't matter: `["A2","A1"]` equals `["A1","A2"]`.
- **Declined attempts are not stored.** Retrying a request that got 409 `SEAT_TAKEN` evaluates it again; it might succeed later if the seat was released. That's safe, because a declined attempt changed nothing.

## 3. Holds, reservations, release and expiry

| State | API status | Ends when |
|-------|------------|-----------|
| `AVAILABLE` | `available` | — |
| `HOLD` | `held` | `held_until` passes (default 10 min, `SEAT_LOCK_EXPIRATION_MINUTES`), or the owner cancels |
| `RESERVED` | `confirmed` | only if the owner cancels |

- **`POST /shows/:id/hold`** is a time-boxed lock, e.g. while the buyer pays. **`POST /shows/:id/reserve`** is the sale. `/reserve` accepts free seats *or* seats the caller holds, so the spec's single-call flow (`/reserve` without a hold) works unchanged.
- **Expiry is lazy.** An expired hold counts as available everywhere: in the seat gate, in the per-user limit count, in `GET /shows/:id`, and in the seat gauges. No background job is needed for correctness, and there's no window where an expired seat is unbookable. The next buyer simply takes it over.
- **Cancel: `POST /reservations/:id/cancel`, owner only.**
  - Runs `cancel_reservation()`, which releases only the seats **still linked to that reservation and owned by that user**.
  - A seat someone else took after the hold expired has a different `reservation_id`, so a late cancel **can never resurrect a seat that now belongs to someone else**.
  - Someone else's reservation id gets 404, exactly like an unknown one.
  - Cancelling twice is harmless (200, nothing released).
  - Released seats are immediately re-bookable.
- **Reconciliation:** `GET /shows/:id` maps every seat to exactly one of `available` / `held` / `confirmed` from one read of the table, so `available + held + confirmed == total_seats` holds by construction. The `seats_*` gauges use the same rule.

## 4. Surviving the stampede (zero 5xx)

- **Hot-seat losers are answered from memory.** Each instance keeps a seat cache: who holds or owns a taken seat, and until when.
  - A request for a seat known to be held or reserved by **someone else** gets 409 without touching the database.
  - A cached "taken" is safe: an owner never changes while a seat stays taken, a hold ends at `held_until` (which the cache stores), and the only other release is the owner's cancel, which this instance applies immediately.
  - The cache can only reject. It never confirms anything.
- **Claim queue:** a FIFO queue in front of the database with one slot per pooled connection, and a 4s maximum wait.
  - Unlike the pool's own queue, a request that gets its turn re-checks the cache before using a connection. Once a hot seat's winner is known, the rest of the storm drains from memory in milliseconds instead of timing out.
  - A request that times out in the queue gets 409 if its seat is known to be taken, otherwise 429.
- **No infrastructure error becomes a 500.** A global exception filter turns pool timeouts, lock and statement timeouts, too many connections, and a dropped or unreachable database into **429 with `Retry-After`**. The client should retry, ideally with the same key.
  - I chose 429 over 503 deliberately: the spec counts 5xx, and these are retryable conditions, not bugs. Only an unclassifiable error (a real bug) is a 500, and it's counted in `unhandled_errors_total`.
- **Fewer round trips:**
  - The JWT is trusted after signature and expiry checks, with no user lookup per request. A token for a user who no longer exists can't book anything (foreign key → 401).
  - Show creation inserts every seat with one statement.
- **Readiness doesn't flap under load.** A database that is reachable but saturated still counts as ready, so a burst can't get the replica pulled from the load balancer. Readiness fails closed (503) only when the database is unreachable or the app is shutting down.
- **Graceful shutdown:** readiness goes 503, in-flight requests finish, the pool closes and telemetry is flushed, all within a 25s deadline.

## 5. Consistency vs availability under a partition

**This service chooses consistency (CP).**
- **Postgres is the only place a seat can be sold.** Nothing confirms a seat without a committed transaction there.
- **If the API can't reach the database** (a partition, failover or outage), every hold, reserve and cancel gets **429 `DB_UNAVAILABLE`** and readiness reports 503. Buyers are turned away rather than given a confirmation that might be wrong.
- **The in-memory seat cache doesn't weaken this.** It can only say "no": a stale cache entry makes the service *less* available (an extra 409 until it lapses), never less correct.
- **Retries after the partition heals are safe:** a request that did commit before the connection dropped is found by its idempotency key and replayed, not booked twice.
- **The cost is availability during the outage.** A ticketing system can afford that; selling the same seat twice is far worse than asking someone to retry.

## 6. Observability: what I'd get paged for at 2am

Everything below comes from `/metrics` (also in Traceway); the README has the full metric list.

| Page when | Why | Query |
|-----------|-----|-------|
| Any 5xx | The contract is zero 5xx; a 5xx means a bug | `sum(increase(http_requests_total{status_code=~"5.."}[5m])) > 0` |
| Unclassified errors | Same, from the error filter's side | `increase(unhandled_errors_total[5m]) > 0` |
| Database down | Nothing can be sold | `db_up == 0` for 1m, or `rate(db_errors_total{reason="DB_UNAVAILABLE"}[5m]) > 0` |
| Reconciliation broken | The invariant must hold for every show | `seats_total - (seats_available + seats_held + seats_confirmed) != 0` |
| Sustained shedding | Buyers are being told to retry | `sum(rate(http_requests_total{status_code="429"}[5m])) / sum(rate(http_requests_total[5m])) > 0.05` for 10m |
| Latency over budget | The database is slow, or the queue is saturated | `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{route="/shows/:id/reserve"}[5m]))) > 2` |
| Saturation (warning, not a page) | Early sign of the above | `claim_queue_waiting > 0` or `db_pool_connections{state="waiting"} > 0` sustained |

Every response carries an `x-request-id` header, which matches `req.id` on its log lines and links to the OpenTelemetry trace. So a single bad response can be followed from the client to the logs and the trace.

## 7. AI usage: directed vs decided

<!-- TODO: review and edit this section so it is accurate and in your own words. -->

I used Claude Code throughout as a pair-programmer and reviewer.

**Decided by me** (AI proposed options; I chose):
- PostgreSQL alone (no Redis, distributed lock or queue), after weighing pessimistic locking, optimistic locking, Redis locks and RedLock for a single-database deployment;
- the seat model: three states (`AVAILABLE` → `HOLD` → `RESERVED`), separate `/hold` and `/reserve` endpoints, owner cancel for both;
- answering infrastructure failures with 429 rather than 503, to honour "zero 5xx";
- trusting the signed token instead of a per-request user lookup;
- the per-user limit counting held + reserved seats; dropping unique show names; default limit 4;
- deployment shape: one Container Apps replica, 10 database connections on a 15-connection free-tier database;
- a 50,100-seat cap per show;
- which audit findings to fix and which to leave.

**Implemented with AI:**
- the `claim_seats()` / `cancel_reservation()` SQL functions and the move from TypeORM `save()` to one round trip per request;
- the seat cache and FIFO claim queue;
- the global exception filter and readiness behaviour;
- the Prometheus metrics, and the bridge that sends them to Traceway;
- the API-only burst script and `burst.sh`;
- the GitHub Actions burst workflow;
- the Swagger and documentation passes.
- these docs

**Caught by testing, not by the AI:**
- 500s under a 20k "spread" load against the remote database (pool exhaustion), which led to the one-round-trip redesign;
- show creation failing at 20k seats;
- connection resets caused by over-tight database timeouts;
- a broken `docker-compose.yml` healthcheck.

I ran the load tests, read the results, and pushed back on suggestions. For example, the claim queue (a semaphore) was required.

## 8. What I'd do next

- **Migrations instead of `synchronize: true`.** Versioned schema changes; `synchronize` can drop and re-add columns and runs on every cold start.
- **More than one replica:**
  - share the cache's view (or drop it) using Postgres `LISTEN/NOTIFY` for cancellations;
  - budget database connections across replicas (or put PgBouncer in front);
  - aggregate metrics across replicas.
- **A payment/confirm step on holds:** a hold converted by a payment webhook, idempotent on the payment id.
- **Automated tests:** concurrency integration tests against a real Postgres (Testcontainers) for the hot seat, the limit, idempotency, cancel and expiry, run in CI.
- **Admission control for much larger on-sales (100k+):** a waiting room or per-user rate limit in front of the API, so the database sees a steady flow.
- **Expired-hold sweeper,** for tidy reporting only. Correctness doesn't need it, because expiry is lazy.
- **Same-region database,** to cut the per-request round trip, which dominates throughput for the "everyone gets a distinct seat" case.
