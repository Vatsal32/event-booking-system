# Event booking system: final plan

## 1. Guarantees

- **No double booking.** Each seat is a single row and the only source of truth. Every status change is a conditional write, and the `bookings` primary key is a second safety net.
- **No partial bookings.** A confirm books every seat in the hold or none of them.
- **Per-user limit per show.** A user's held + booked seats for a show never exceed `max_seats_per_user`, even with parallel requests from several tabs.
- **No 5xx caused by SQL.** Expected outcomes come back as "0 rows", never as exceptions. Every SQL error code maps to a fixed response. A 5xx happens only when Postgres is unreachable.
- **Idempotent.** A hold uses the client's `idempotency_key`. Confirm and payment use `hold_id`.
- **Handles a 50k burst.** Most losing requests are rejected from the API's in-memory seat cache without touching the database, and the rest with one read. Only requests for seats that were free a moment ago open a transaction.

## 2. Architecture

```
Client → Load balancer (TLS) → API × N (stateless) → Postgres primary (+ optional HA standby)
```

- **Each API instance** has a bounded connection pool (~8 connections) and an in-memory seat cache per show. The cache is refreshed every 1s (one fetch at a time per show) and also updated by every fast-path read. It serves the seat map and rejects most losers.
- **No Redis, queue, CDN, rate limiting, waiting room or PgBouncer.**
- **Capacity:** database work grows with the number of seats claimed, not the number of requests. Even in the worst case, where every request ran the full ~1–2ms transaction, 50k × 1.5ms ÷ 32 connections ≈ **2–3s of database time**.

## 3. Schema

```sql
CREATE TABLE shows (
  show_id            bigint PRIMARY KEY,
  starts_at          timestamptz NOT NULL,
  max_seats_per_user int NOT NULL CHECK (max_seats_per_user > 0)
);

CREATE TABLE seats (
  show_id         bigint NOT NULL REFERENCES shows,
  seat_id         text   NOT NULL,
  status          text   NOT NULL DEFAULT 'AVAILABLE'
                  CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
  hold_id         uuid,          -- groups the seats in one hold; becomes the booking_id
  held_by         bigint,        -- owner; stays set after booking (used for the per-user limit)
  hold_seat_count smallint,      -- seats in the hold; confirm books all of them or none
  hold_expires_at timestamptz,
  PRIMARY KEY (show_id, seat_id)
);
CREATE INDEX ON seats (hold_id);
CREATE INDEX ON seats (hold_expires_at) WHERE status = 'HELD';
CREATE INDEX ON seats (show_id, held_by) WHERE held_by IS NOT NULL;   -- per-user limit count

CREATE TABLE bookings (           -- one row per booked seat
  show_id     bigint NOT NULL,
  seat_id     text   NOT NULL,
  booking_id  uuid   NOT NULL,    -- = hold_id
  user_id     bigint NOT NULL,
  payment_ref text   NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, seat_id)  -- safety net: a seat can never be booked twice
);
CREATE INDEX ON bookings (booking_id);

CREATE TABLE booking_requests (   -- idempotency
  user_id      bigint NOT NULL,   -- taken from the auth token, never the body
  idem_key     text   NOT NULL
               CHECK (length(idem_key) BETWEEN 1 AND 255),   -- an oversized key would exceed the btree row limit
  request_hash text   NOT NULL,   -- sha256(show_id : sorted seat_ids)
  response     jsonb  NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);
```

**Seat lifecycle:**
- `AVAILABLE → HELD` on hold.
- `HELD → BOOKED` on confirm.
- `HELD → AVAILABLE` when the hold expires. The expiry check is in every WHERE clause, and a sweeper cleans up separately.

## 4. API

### `POST /holds`: `{ idempotency_key, show_id, seat_ids }`

1. **Validate before any SQL.** `idempotency_key` must be 1–255 characters; `show_id` an integer; `seat_ids` 1–10 entries with no duplicates. Otherwise → 400.
2. **In-memory check (no database).** If any requested seat in the instance's seat cache is `BOOKED`, or `HELD` with `hold_expires_at` in the future, by someone other than the caller → 409 `SEAT_TAKEN`.
3. **Fast-path read.** One autocommit read with no transaction, locks or writes:

```sql
SELECT seat_id, status, held_by, hold_id, hold_expires_at,
       (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now())) AS is_free
FROM seats
WHERE show_id = :show AND seat_id = ANY(:seats);
```

   - Write the rows into the instance's seat cache, so the next request for these seats is answered from memory.
   - Fewer rows than requested → 404.
   - Any seat not free and held by someone other than the caller → 409 `SEAT_TAKEN`.
   - Otherwise → step 4.

4. **Hold transaction.** No `SET LOCAL`: the role-level timeouts (section 6) apply.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- a. claim the idempotency key
INSERT INTO booking_requests (user_id, idem_key, request_hash, response)
VALUES (:user, :key, :hash, '{}')
ON CONFLICT (user_id, idem_key) DO NOTHING
RETURNING idem_key;
--   no row returned → ROLLBACK, read the stored row: hash differs → 422, else replay its response
--   55P03 here → 409 REQUEST_IN_PROGRESS

-- b. one hold at a time per (user, show); other users never wait on this lock.
--    MUST stay a separate statement from c: under READ COMMITTED a statement's snapshot is
--    taken when it starts, so c sees the previous holder's commit only if it starts after
--    this lock is granted. Merging b and c would let parallel requests bypass the limit.
SELECT pg_advisory_xact_lock(hashtextextended(format('%s:%s', :show, :user), 0));
--   55P03 here → 409 REQUEST_IN_PROGRESS

-- c. per-user limit: seats already owned (not counting the requested ones) + requested
--    an owned seat counts while hold_expires_at > now()
SELECT sh.max_seats_per_user,
       (SELECT count(*) FROM seats s
        WHERE s.show_id = :show AND s.held_by = :user
          AND s.seat_id <> ALL(:seats)
          AND (s.status = 'BOOKED' OR (s.status = 'HELD' AND s.hold_expires_at > now()))
       ) AS owned
FROM shows sh WHERE sh.show_id = :show;
--   no row → ROLLBACK → 404
--   owned + cardinality(:seats) > max_seats_per_user → ROLLBACK → 409 SEAT_LIMIT_EXCEEDED

-- d. seat gate: lock only seats that are still free, always in the same order
--    a seat is free once hold_expires_at <= now(), the exact complement of c
SELECT seat_id FROM seats
WHERE show_id = :show AND seat_id = ANY(:seats)
  AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))
ORDER BY seat_id
FOR UPDATE;
--   A waiter re-checks the WHERE against the winner's committed row and skips it.
--   fewer rows than requested, or 55P03 / 57014 / 25P04 → ROLLBACK → classify (step 5)

-- e. hold the seats; the guard repeats d's condition in case a future change skips d
WITH upd AS (
  UPDATE seats
     SET status = 'HELD', hold_id = :hold, held_by = :user,
         hold_seat_count = cardinality(:seats),
         hold_expires_at = now() + make_interval(secs => :ttl_seconds)   -- env HOLD_TTL_SECONDS
   WHERE show_id = :show AND seat_id = ANY(:seats)
     AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))
  RETURNING hold_expires_at
)
SELECT count(*) AS updated_rows, min(hold_expires_at) AS hold_expires_at FROM upd;
--   updated_rows <> cardinality(:seats) → ROLLBACK → 409 CONFLICT + alert (should be impossible)

-- f. store the response for replays
UPDATE booking_requests SET response = :response
WHERE user_id = :user AND idem_key = :key;

COMMIT;
--   40P01 / 40001 anywhere → ROLLBACK, retry the whole transaction (max 3, jittered), then 429
```

5. **Classify a failed hold** by running the fast-path read again:
   - Fewer rows than requested → 404.
   - Every seat is `HELD` by the caller under one unexpired `hold_id` (another tab got there first) → 200 with that hold.
   - Every seat is still free (the gate only timed out) → 409 `SEAT_BUSY`, retryable.
   - Otherwise → 409 `SEAT_TAKEN`.

**Why rejecting from memory is safe**
- A hold only ends by expiring, and the cache stores `hold_expires_at`, so each instance knows exactly when a cached hold stops counting. `BOOKED` seats never become free. So a cached "taken by someone else" is never wrong, apart from a few milliseconds of clock skew between the app and the database. If cancellations are added later, they must also update the cache.
- A cached "free" can be stale, but that only sends the request on to the fast-path read. The database still decides.
- Seats held by the caller skip the in-memory rejection, so idempotent replays and the second-tab case still return the existing hold.

**How the limit works**
- **What counts:** held + booked seats. Otherwise a user could hold the maximum, book them, and hold the maximum again. If only active holds should count, remove the `status = 'BOOKED'` condition in step c.
- **Why the lock (step b) is needed:** without it, two tabs could each see "4 of 6 used", each add 2, and end at 8. The lock makes one user's holds for one show run one at a time. Other users never wait on it, so it adds nothing to the burst.
- **Requested seats are left out of `owned`.** So a second tab asking for seats this user already holds still reaches step 5 and gets 200 with the existing hold, instead of a limit error.
- **Expired holds stop counting immediately** because of `hold_expires_at > now()`. Confirm (`HELD → BOOKED`) doesn't change the count.

Only successful holds are stored. The ROLLBACK removes the key, so a retry of a failed attempt simply runs again. That's safe because the failed attempt changed nothing.

### `POST /holds/{hold_id}/confirm`

1. **Charge the payment provider** with `hold_id` as its idempotency key, never inside a database transaction. The hold TTL (e.g. 10 min) must be longer than the payment timeout (e.g. 5 min).
2. **On payment success, run the confirm transaction.** It may be triggered by the client callback, the provider's webhook, or both; running it twice is safe.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- lock the hold's seats in ascending order (same order as step d) before updating;
-- a multi-row UPDATE alone locks in scan order and could deadlock with step d
SELECT seat_id, hold_seat_count FROM seats
WHERE hold_id = :hold AND held_by = :user
  AND status = 'HELD' AND hold_expires_at > now()
ORDER BY show_id, seat_id
FOR UPDATE;
--   0 rows                        → ROLLBACK → step 3
--   row count <> hold_seat_count  → ROLLBACK → 409 HOLD_EXPIRED + refund

WITH booked AS (
  UPDATE seats SET status = 'BOOKED'
  WHERE hold_id = :hold AND held_by = :user
    AND status = 'HELD' AND hold_expires_at > now()
  RETURNING show_id, seat_id
)
INSERT INTO bookings (show_id, seat_id, booking_id, user_id, payment_ref)
SELECT show_id, seat_id, :hold, :user, :payment_ref FROM booked;

COMMIT;
```

3. **If 0 rows were locked**, check for a retry:

```sql
SELECT 1 FROM bookings WHERE booking_id = :hold AND user_id = :user LIMIT 1;
--   found → 200 with the existing booking; else → 409 HOLD_EXPIRED + refund
--   (the user_id check stops anyone reading another user's booking)
```

**Why the `hold_seat_count` check is needed.** A confirm that starts just before the hold expires still sees the hold as valid. Another user's hold that starts just after expiry sees the same seats as free. If that user locks one of the seats first, the confirm skips it and would book the rest. Comparing the locked row count with `hold_seat_count` turns that into 409 `HOLD_EXPIRED` + refund instead of a partial booking.

### `GET /shows/{id}/seats`

Served from the instance's seat cache, which is refreshed with:

```sql
SELECT seat_id, status, held_by, hold_id, hold_expires_at
FROM seats WHERE show_id = :show;
```

The response drops `held_by` and `hold_id`, and shows a `HELD` seat whose `hold_expires_at` has passed as `AVAILABLE`.

The client greys out every seat that isn't `AVAILABLE`, so most users never send a hold request for a taken seat.

## 5. Sweeper (every 30s, housekeeping only)

```sql
WITH expired AS (
  SELECT show_id, seat_id FROM seats
  WHERE status = 'HELD' AND hold_expires_at <= now()
  LIMIT 1000
  FOR UPDATE SKIP LOCKED          -- never waits, so it can't deadlock and needs no ORDER BY
)
UPDATE seats s
   SET status = 'AVAILABLE', hold_id = NULL, held_by = NULL,
       hold_seat_count = NULL, hold_expires_at = NULL
  FROM expired e
 WHERE s.show_id = e.show_id AND s.seat_id = e.seat_id
   AND s.status = 'HELD' AND s.hold_expires_at <= now();   -- re-check; never touches BOOKED

DELETE FROM booking_requests WHERE created_at < now() - interval '24 hours';
```

## 6. Database and connection settings

```sql
ALTER ROLE booking_app SET default_transaction_isolation = 'read committed';
ALTER ROLE booking_app SET lock_timeout = '1s';                         -- one lock wait
ALTER ROLE booking_app SET statement_timeout = '2s';                    -- one statement, not the transaction
ALTER ROLE booking_app SET idle_in_transaction_session_timeout = '2s';  -- app stalled mid-transaction
ALTER ROLE booking_app SET transaction_timeout = '5s';                  -- whole transaction (Postgres 17+)
```

- **Role-level defaults** apply to every code path, including the cache refresh, the fast-path read and the sweeper. Transactions don't run `SET LOCAL`, which also saves round trips.
- **Timeout order:** lock (1s) < statement (2s) < transaction (5s). The HTTP deadline (e.g. 10s) is longer than the pool wait (2s) plus `transaction_timeout`. On Postgres below 17, drop the `transaction_timeout` line; `statement_timeout` and `idle_in_transaction_session_timeout` then bound the transaction.
- **Isolation level:** `READ COMMITTED`, set by the role and by every `BEGIN`. Check it once in an integration test, not on every request. Conditional writes and the per-user lock make stricter isolation unnecessary.
- **Lock order, which rules out deadlocks:** every hold takes locks in the same order: idempotency key → per-user lock → seats in `seat_id` order. Confirm takes only seat locks, in the same order. The sweeper never waits.
- **Pool size:** total connections ≈ 2–4× the database's CPU cores. If no connection is free within 2s → 429 `SERVER_BUSY` + `Retry-After`. Requests rejected from memory never take a connection.
- **Transactions:** keep them short, always ROLLBACK on any exception, and never call external services inside one.
- **SQL:** static, parameterized queries only.

## 7. Responses and error mapping

All errors go through one central mapper.

| Response | Triggered by |
|---|---|
| 200 | Hold created · replay of the same key · seats already held by you · confirm or a confirm retry |
| 400 `INVALID_INPUT` | Request validation · SQL codes `22xxx`, `23502`, `23514` (e.g. idempotency key over 255 characters) |
| 404 `NOT_FOUND` | Show missing (limit step) · seat missing (fast-path or classify read) · `23503` |
| 409 `SEAT_TAKEN` | In-memory check · fast-path read · classify read after a failed hold |
| 409 `SEAT_BUSY` | Classify read finds every seat still free after the gate failed (`55P03`/`57014`/`25P04`); retryable |
| 409 `SEAT_LIMIT_EXCEEDED` | owned + requested > `max_seats_per_user`; the response body includes `limit` and `remaining` |
| 409 `REQUEST_IN_PROGRESS` | `55P03` on the idempotency INSERT or the per-user lock |
| 409 `HOLD_EXPIRED` | Confirm locked fewer rows than `hold_seat_count`, or 0 rows with no existing booking (+ refund) |
| 409 `CONFLICT` + alert | `23505` on `bookings`, or step e held fewer seats than requested: a safety net fired, which means a bug |
| 422 `IDEMPOTENCY_KEY_MISMATCH` | Same key, different `request_hash` |
| 429 `SERVER_BUSY` | No pool connection within 2s · `40P01`/`40001` after 3 retries |
| 503 + `Retry-After` | `08xxx`/`53xxx`/`57xxx`/`25P04` outside the seat gate, after retries (Postgres unreachable or overloaded) |
| Alert; fix in CI | `42xxx` and anything else unmapped |

## 8. Database high availability (optional)

- **Synchronous replication**, so a committed booking survives a failover. Use managed HA (RDS Multi-AZ, Cloud SQL HA) or Patroni with `synchronous_mode: true` and `watchdog: mode: required` (the watchdog prevents two primaries).
- **Connection routing:** the managed endpoint, or a libpq multi-host string with `target_session_attrs=read-write`.
- **App retries** connection errors with backoff inside the request deadline. Holds (idempotency key) and confirms (`hold_id`) are idempotent, so a retry also answers "did my COMMIT land?".

## 9. Tests

- **Concurrency** (real Postgres via Testcontainers):
  - 1,000 parallel holds on the same seats, including overlapping multi-seat sets in shuffled order → exactly 1 × 200, the rest 409, 0 × 5xx.
  - Duplicate keys get the same response.
  - Confirm retries produce exactly one booking.
  - Each seat has exactly one `bookings` row.
- **Loser fast path:** after a seat is taken, 10,000 more holds for it all get 409, and almost none of them reach the database (count queries with `pg_stat_statements`).
- **No partial confirm:** drive two transactions by hand. U's confirm for {A1, A2} begins just before the hold expires; V takes A1 just after expiry and commits; U's confirm continues → 409 `HOLD_EXPIRED`, and no `bookings` rows exist for the hold.
- **Per-user limit** (with a limit of 4):
  - One user sends 20 parallel holds for different seats, each with its own key → at most 4 seats held, the rest 409 `SEAT_LIMIT_EXCEEDED`, 0 × 5xx.
  - Hold 4 → confirm → try to hold 1 more → 409.
  - Let a hold expire → the user can hold again.
  - A second tab asking for seats the user already holds → 200 with the existing hold.
- **Expiry:** after a hold expires, another user can take the seat; a late confirm gets 409 `HOLD_EXPIRED` and a refund.
- **Isolation:** one test asserts `current_setting('transaction_isolation') = 'read committed'` inside the hold transaction.
- **Load (k6):** 50k virtual users on 10 hot seats → 0 × 5xx, one winner per seat, p99 latency within the deadline.
