# Event booking system: final plan (rev 2)

Names and endpoints are unchanged from rev 1 and still need aligning with the assignment's contract. This revision covers only the "fix before the burst" items.

## What changed in this revision

| # | Fix | Where |
|---|---|---|
| 1 | Overload and timeouts never become 5xx or 429 for losers. New error mapping, deadline budget and retry policy. Same-key concurrent retries replay instead of returning `REQUEST_IN_PROGRESS`. `SEAT_BUSY` is retried internally. | §1, §4.2–4.3, §6, §7 |
| 2 | Capacity math restated with real round-trip counts. The hold transaction is reordered so a decline writes nothing, and costs 7 round trips. Per-seat gate, cache-first checks, a skippable pre-check, and a measured switch to a one-round-trip function. | §2, §4.1–4.2, Appendix A |
| 3 | Reads are never stale. Write-through on commit, a monotonic cache merge, and a live single-flight state read. | §2, §4, §4.4, Appendix B |

## 1. Guarantees

- **No double booking.** Each seat is a single row and the only source of truth. Every status change is a conditional write, and the `bookings` primary key is a second safety net.
- **No partial bookings.** A confirm books every seat in the hold or none of them.
- **Per-user limit per show.** A user's held + booked seats for a show never exceed `max_seats_per_user`, even with parallel requests from several tabs.
- **No 5xx caused by SQL or load.**
    - Expected outcomes come back as codes or "0 rows", never as exceptions.
    - Lock waits and statement or transaction timeouts are classified or retried, never returned as 5xx.
    - A 5xx happens only when Postgres is unreachable (`08xxx`, `57P01`–`57P03`, `53300`, driver connection failures), and only after retries inside the request deadline.
- **Losers get 409, not 429.** A request for a seat that is already taken receives 409 even when the server is saturated, because the cache is re-checked after every wait.
- **Idempotent.**
    - A hold uses the client's `idempotency_key`. Confirm and payment use `hold_id`.
    - A concurrent retry of the same key waits and then receives the original response.
    - A retry after a lost COMMIT receives the committed result.
- **Handles a 50k burst.** Most losing requests are rejected from memory (cache and per-seat gate) or with one read. Only requests for seats that were free a moment ago open a transaction, and a declined transaction writes nothing.

## 2. Architecture

```
Client → Load balancer (TLS) → API × N → Postgres primary (+ optional HA standby)
```

Each API instance holds:
- **A DB semaphore.** Permits = 8 on a pool of 10, so 2 connections stay free for state reads, the sweeper and the cache refresh.
- **A seat cache per show.** Rejects losers. It is written through on every commit and refreshed with a monotonic merge (Appendix B).
- **A per-seat gate.** An in-process queue per seat, so one request per seat goes to the DB at a time (Appendix B).
- **A single-flight state reader per show** (Appendix B).

No Redis, queue, CDN, waiting room or PgBouncer. The cache, gate and single-flight are per instance. With several instances the extra concurrent attempts are harmless because the DB decides, but one API instance is the recommended deployment.

### Capacity, with the real numbers

Cost of a full hold transaction = round trips × RTT.

| Variant | Round trips | At ~1 ms RTT |
|---|---|---|
| Transaction in §4.2 | 7 (BEGIN, per-user lock, key-read + limit, seat gate, hold, key insert, COMMIT) | ≈ 7–10 ms |
| One call to the function in Appendix A | 1 | ≈ 1.5–3 ms |

- **Throughput of the transaction version:** 8 permits ÷ ~9 ms ≈ 900 full transactions per second per instance.
- **Unfiltered, this is too slow.** 20k full transactions would take about 20–25 s of pooled time, and a winner would hold its seat lock for ~9 ms. The filtering below is load-bearing:

| Request | DB cost |
|---|---|
| Seat cached as taken by someone else | 0 |
| Queued behind the per-seat gate, then cache says taken | 0 |
| Cache fresh and says free | 1 transaction, no pre-check |
| No cache entry, or a stale one | 1 pre-check read, then a transaction only if free |

So full transactions ≈ seats actually claimed plus a few overlaps. For a 2,000-seat hall that is about 2,000 × 10 ms ÷ 8 ≈ 2.5 s of DB time.

**Switch rule:** run the constrained burst. If the hold-transaction p99 exceeds 100 ms, or the semaphore queue is still non-empty after the first second of a burst, move to Appendix A.

## 3. Schema

Unchanged from rev 1 (`shows`, `seats` with `hold_seat_count`, `bookings`, `booking_requests` with `idem_key text CHECK (length BETWEEN 1 AND 255)`).

**Seat lifecycle:** `AVAILABLE → HELD` on hold, `HELD → BOOKED` on confirm, `HELD → AVAILABLE` when the hold expires (checked in every WHERE clause, plus the sweeper).

## 4. API

### 4.1 `POST /holds`: `{ idempotency_key, show_id, seat_ids }`

Request pipeline. Each wait is bounded by the request deadline (§6), and every step that can wait re-checks the cache afterwards:

1. **Validate before any SQL.** `idempotency_key` 1–255 characters; `show_id` an integer; `seat_ids` 1–10 entries with no duplicates. Otherwise → 400.
2. **Cache check (no DB).** Any requested seat taken by someone else → 409 `SEAT_TAKEN`.
3. **Per-seat gate.** Acquire the gate for the sorted seat ids. After acquiring it, **re-check the cache**; the previous holder may have just landed → 409. The gate is held until the transaction has finished and the cache has been written through.
4. **DB semaphore.** Wait for a permit up to the remaining deadline. After acquiring it, **re-check the cache again** → 409. Only then is a connection used. If the deadline expires first, return 429 `SERVER_BUSY`; this is the only case where a queued request gets 429.
5. **Pre-check.** Skip it when the cache has a fresh entry (refreshed within 1 s) for every requested seat and all are free; the transaction re-decides anyway. Otherwise run the fast-path read:

```sql
SELECT seat_id, status, held_by, hold_id, hold_expires_at,
       (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now())) AS is_free
FROM seats
WHERE show_id = :show AND seat_id = ANY(:seats);
```
- Merge the rows into the cache (Appendix B rules).
- Fewer rows than requested → 404.
- Any seat not free and held by someone other than the caller → 409 `SEAT_TAKEN`.
- Otherwise → step 6.
6. **Hold transaction (§4.2) inside the retry loop (§4.3).** On success, write the held seats through to the cache **before releasing the gate**.
7. **Classify** a failed hold (§4.3).

**Why rejecting from memory is safe**
- A hold only ends by expiring, and the cache stores `until`, so a cached "taken by someone else" stays valid until `until` (minus a skew margin for app–DB clock differences). `BOOKED` never becomes free. If cancellations are added later, they must also update the cache.
- A cached "free" may be stale. That only sends the request on, and the database still decides.
- Seats held by the caller skip the in-memory rejection, so replays and the second-tab case still return the existing hold.

### 4.2 Hold transaction (a decline writes nothing)

The key row is inserted **last**. Everything before it only reads or takes locks, so any decline is a plain ROLLBACK with nothing to undo. Same-user, same-show requests, including same-key retries, are already serialized by the per-user lock, so the key check needs no write.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- b. one hold at a time per (user, show); other users never wait on this lock.
--    MUST stay a separate statement from the next one: under READ COMMITTED a statement's snapshot
--    is taken when it starts, so the next statement sees the previous holder's commit only if it
--    starts after this lock is granted.
SELECT pg_advisory_xact_lock(hashtextextended(format('%s:%s', :show, :user), 0));
--   55P03 here → the same user's other request holds the lock → app sleeps 20–50 ms and retries
--   the whole attempt until the deadline (§4.3); the next attempt replays the committed result

-- a + c in ONE statement (both run after b, so the snapshot is fresh):
--   prior = the stored response for this key, if any
--   owned = seats this user already owns (not counting the requested ones)
SELECT
  (SELECT jsonb_build_object('hash', br.request_hash, 'response', br.response)
     FROM booking_requests br
    WHERE br.user_id = :user AND br.idem_key = :key)  AS prior,
  sh.max_seats_per_user,
  (SELECT count(*) FROM seats s
    WHERE s.show_id = :show AND s.held_by = :user
      AND s.seat_id <> ALL(:seats)
      AND (s.status = 'BOOKED' OR (s.status = 'HELD' AND s.hold_expires_at > now()))
  ) AS owned
FROM shows sh WHERE sh.show_id = :show;
--   no row                                  → ROLLBACK → 404
--   prior present, hash differs             → ROLLBACK → 422 (see "still open")
--   prior present, hash equal               → ROLLBACK → replay prior.response
--   owned + cardinality(:seats) > max       → ROLLBACK → 409 SEAT_LIMIT_EXCEEDED

-- d. seat gate: lock only seats that are still free, always in the same order.
--    Free once hold_expires_at <= now(), the exact complement of the count above.
SELECT seat_id FROM seats
WHERE show_id = :show AND seat_id = ANY(:seats)
  AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))
ORDER BY seat_id
FOR UPDATE;
--   A waiter re-checks the WHERE against the winner's committed row and skips it.
--   fewer rows than requested, or 55P03 / 57014 / 25P04 → ROLLBACK → classify (§4.3)

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
SELECT count(*) AS updated_rows,
       (extract(epoch FROM min(hold_expires_at)) * 1000)::bigint AS expires_at_ms
FROM upd;
--   updated_rows <> cardinality(:seats) → ROLLBACK → 409 CONFLICT + alert (should be impossible)

-- f. store the replay response, with the final content, last
INSERT INTO booking_requests (user_id, idem_key, request_hash, response)
VALUES (:user, :key, :hash, :response)
ON CONFLICT (user_id, idem_key) DO NOTHING
RETURNING idem_key;
--   no row (the same key was used concurrently for a different show) → ROLLBACK →
--   re-read the key → hash differs → 422 (see "still open"), else replay

COMMIT;
```

**Lock order:** per-user lock → seats in `seat_id` order → key insert. The key insert waits only on an uncommitted insert of the same key by another transaction that already holds all its locks, so no cycle is possible.

### 4.3 Retry loop, deadline and classification

**Deadline `D = REQUEST_DEADLINE_MS` (10 s).** Every wait (gate, semaphore, retry sleep) is bounded by the remaining time. No attempt starts with less than 1.5 s left.

| Condition | Action |
|---|---|
| `55P03` at the per-user lock | Sleep 20–50 ms (jitter) and retry until the deadline. The next attempt finds the committed key and replays. At the deadline → 409 `REQUEST_IN_PROGRESS` + `Retry-After`. |
| `55P03` / `57014` / `25P04` at the seat gate (d), or fewer rows than requested | ROLLBACK → **classify** (below) |
| `40P01` / `40001` | Retry the whole attempt, up to 3 attempts in total, 5–25 ms jitter → then 429 |
| `57014` / `25P04` anywhere else, `25P03`, connection reset or terminated | Retry up to 2 more times. The key check under the per-user lock answers "did my COMMIT land?". Then 429 for timeouts, 503 only if Postgres is unreachable. |
| `08xxx`, `57P01`–`57P03`, `53300` | Retry within the deadline, then 503 + `Retry-After` |

**Classify** a failed hold by running the fast-path read again (and merging the result into the cache):
- Fewer rows than requested → 404.
- Every seat is `HELD` by the caller under one unexpired `hold_id` (another tab got there first) → 200 with that hold.
- Some seat is not free and held by someone else → 409 `SEAT_TAKEN`.
- **Every seat is still free** (the gate only timed out or a lock holder rolled back): retry the hold up to 2 more times with 20–60 ms jitter. If still unresolved → 409 `SEAT_BUSY` (retryable). The internal retries keep a hot seat from ending with no winner when a lock holder fails.

**How the limit works**
- **What counts:** held + booked seats. Otherwise a user could hold the maximum, book them, and hold the maximum again. If only active holds should count, remove the `status = 'BOOKED'` condition.
- **Why the lock is needed:** without it, two tabs could each see "4 of 6 used", each add 2, and end at 8. One user's holds for one show run one at a time. Other users never wait on it.
- **Requested seats are left out of `owned`**, so a second tab asking for seats this user already holds still reaches classify and gets 200 with the existing hold.
- **Expired holds stop counting immediately** because of `hold_expires_at > now()`. Confirm does not change the count.

Only successful holds are stored. A decline writes nothing, so a retry simply runs again.

### 4.4 `POST /holds/{hold_id}/confirm`

1. **Charge the payment provider** with `hold_id` as its idempotency key, never inside a database transaction. The hold TTL (e.g. 10 min) must be longer than the payment timeout (e.g. 5 min).
2. **On payment success, run the confirm transaction.** It may be triggered by the client callback, the provider's webhook, or both; running it twice is safe.

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;

-- lock the hold's seats in ascending order (same order as seat gate d) before updating;
-- a multi-row UPDATE alone locks in scan order and could deadlock with d
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

On success, **write BOOKED through to the cache after COMMIT** (`until = Infinity`, owner = caller).

3. **If 0 rows were locked**, check for a retry:

```sql
SELECT 1 FROM bookings WHERE booking_id = :hold AND user_id = :user LIMIT 1;
--   found → 200 with the existing booking; else → 409 HOLD_EXPIRED + refund
--   (the user_id check stops anyone reading another user's booking)
```

**Why the `hold_seat_count` check is needed.** A confirm that starts just before the hold expires still sees the hold as valid. Another user's hold that starts just after expiry sees the same seats as free. If that user locks one of the seats first, the confirm skips it and would book the rest. Comparing the locked row count with `hold_seat_count` turns that into 409 `HOLD_EXPIRED` + refund instead of a partial booking.

Confirm uses the same retry policy as §4.3 for `40P01`, `40001` and connection errors.

### 4.5 `GET /shows/{id}/seats` (live, never stale)

Served by a **single-flight** reader: every request is answered by a query that **started after the request arrived**, and concurrent requests share one query (Appendix B). This costs the same DB load as a 1 s cache without the staleness.

```sql
SELECT seat_id, status, held_by, hold_id, hold_expires_at
FROM seats WHERE show_id = :show ORDER BY seat_id;
```

- Compute the response's `counts` and `total` **in code from this one result set**, so `available + held + booked == total` in every response.
- Show a `HELD` seat whose `hold_expires_at <= now()` as `AVAILABLE`.
- The response drops `held_by` and `hold_id`.
- Merge the same rows into the seat cache (Appendix B rules).

## 5. Sweeper (every 30 s, housekeeping only)

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
```

Delete old keys in batches, because `statement_timeout` is 2 s:

```sql
DELETE FROM booking_requests
WHERE ctid IN (SELECT ctid FROM booking_requests
               WHERE created_at < now() - interval '24 hours' LIMIT 5000);
```

With several instances, run the sweeper under `pg_try_advisory_lock` so only one does.

## 6. Database and connection settings

```sql
ALTER ROLE booking_app SET default_transaction_isolation = 'read committed';
ALTER ROLE booking_app SET lock_timeout = '1s';                         -- one lock wait
ALTER ROLE booking_app SET statement_timeout = '2s';                    -- one statement, not the transaction
ALTER ROLE booking_app SET idle_in_transaction_session_timeout = '5s';  -- app stalled mid-transaction
ALTER ROLE booking_app SET transaction_timeout = '5s';                  -- whole transaction (Postgres 17+)
```

- **`idle_in_transaction_session_timeout` is 5 s, not 2 s.** On a small instance an event-loop stall under a burst can exceed 2 s, and the server would kill the connection mid-transaction. If it still happens, it is treated as retryable (§4.3).
- **Role-level defaults** apply to every code path, so transactions run no `SET LOCAL`.
- **Timeout order:** lock (1 s) < statement (2 s) < transaction (5 s) < request deadline (10 s). On Postgres below 17, drop `transaction_timeout`.
- **Isolation:** `READ COMMITTED`, set by the role and by every `BEGIN`. Check it once in an integration test, not on every request.
- **Lock order, which rules out deadlocks:** per-user lock → seats in `seat_id` order → key insert. Confirm takes only seat locks, in the same order. The sweeper never waits.
- **Pool 10, semaphore 8.** The semaphore (not the pool) is where requests wait, bounded by the deadline. Requests rejected from memory never take a permit.
- **Transactions:** keep them short, always ROLLBACK on any exception, never call external services inside one.
- **SQL:** static, parameterized queries only.

## 7. Responses and error mapping

All errors go through one central mapper.

| Response | Triggered by |
|---|---|
| 200 | Hold created · replay of the same key · seats already held by you · confirm or a confirm retry |
| 400 `INVALID_INPUT` | Request validation · SQL codes `22xxx`, `23502`, `23514` (e.g. idempotency key over 255 characters) |
| 404 `NOT_FOUND` | Show missing · seat missing (pre-check or classify) · `23503` |
| 409 `SEAT_TAKEN` | Cache check (initial, after the gate, after the permit) · pre-check · classify |
| 409 `SEAT_BUSY` | Classify finds every seat still free after 2 internal retries; retryable |
| 409 `SEAT_LIMIT_EXCEEDED` | owned + requested > `max_seats_per_user`; the body includes `limit` and `remaining` |
| 409 `REQUEST_IN_PROGRESS` | The deadline expired while waiting on the per-user lock for the same user's concurrent request |
| 409 `HOLD_EXPIRED` | Confirm locked fewer rows than `hold_seat_count`, or 0 rows with no existing booking (+ refund) |
| 409 `CONFLICT` + alert | `23505` on `bookings`, or step e held fewer seats than requested: a safety net fired, which means a bug |
| 422 `IDEMPOTENCY_KEY_MISMATCH` | Same key, different `request_hash` |
| 429 `SERVER_BUSY` + `Retry-After` | Deadline expired while waiting for the gate or a permit (seat not known taken) · `40P01`/`40001` after 3 attempts · `57014`/`25P04`/`25P03` after retries |
| 503 + `Retry-After` | Only `08xxx`, `57P01`–`57P03`, `53300` and driver connection failures that persist after retries within the deadline |
| Alert; fix in CI | `42xxx` and anything else unmapped |

## 8. Database high availability (optional)

- **Synchronous replication**, so a committed booking survives a failover. Use managed HA (RDS Multi-AZ, Cloud SQL HA) or Patroni with `synchronous_mode: true` and `watchdog: mode: required`.
- **Connection routing:** the managed endpoint, or a libpq multi-host string with `target_session_attrs=read-write`.
- **App retries** connection errors with backoff inside the request deadline. A retry is safe because the key check under the per-user lock returns the committed result if the first COMMIT landed.

## 9. Tests

- **Concurrency** (real Postgres via Testcontainers):
    - 1,000 parallel holds on the same seats, including overlapping multi-seat sets in shuffled order → exactly 1 × 200, the rest 409, 0 × 5xx.
    - Same key ×50 concurrently → every response is 2xx with the same `hold_id` and exactly one hold exists.
    - Confirm retries produce exactly one booking; each seat has one `bookings` row.
- **Loser fast path:** after a seat is taken, 10,000 more holds for it all get 409, and almost none reach the DB (count queries with `pg_stat_statements`).
- **Saturation keeps losers at 409:** hold all semaphore permits and fill the queue during a hot-seat storm → the only statuses are 200 and 409 (no 429 for requests whose seat is taken).
- **Timeouts are not 5xx:**
    - Force `statement_timeout` on a statement → retry or 429, never 5xx.
    - `pg_terminate_backend` a connection mid-transaction (and idle-in-transaction) → the retry succeeds, the invariant holds and no seat is double-held.
    - A lost COMMIT response (kill the connection right after COMMIT) → the retry replays the committed hold.
- **Freshness:** immediately after the burst finishes, `GET` counts equal the number of winning holds. A cache refresh that started before a write-through never overwrites the newer entry (unit test).
- **No partial confirm:** U's confirm for {A1, A2} begins just before expiry; V takes A1 just after expiry and commits; U's confirm → 409 `HOLD_EXPIRED` and no `bookings` rows for the hold.
- **Per-user limit** (limit 4): 20 parallel holds with different seats and keys → at most 4 held, the rest 409, 0 × 5xx; hold 4 → confirm → hold 1 more → 409; after expiry the user can hold again; second tab on the same seats → 200 with the existing hold.
- **Isolation:** assert `current_setting('transaction_isolation') = 'read committed'` inside the hold transaction.
- **Load (k6):** 50k virtual users on 10 hot seats → 0 × 5xx, one winner per seat, p99 within the deadline. Run once with the §4.2 transaction and once with Appendix A to confirm the switch rule.

---

## Appendix A: the hold as one round trip

Use this if the §2 switch rule triggers. The app calls it in autocommit and reads the returned code; role-level timeouts apply to the call, and the whole function is one transaction.

```sql
CREATE OR REPLACE FUNCTION hold_seats(
  p_show bigint, p_user bigint, p_key text, p_hash text,
  p_seats text[], p_hold uuid, p_ttl_seconds int
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE   -- REQUIRED: a volatile function gets a fresh snapshot per statement under READ COMMITTED.
           -- STABLE/IMMUTABLE would reuse the caller's snapshot and break the per-user limit.
AS $$
DECLARE
  v_req record; v_limit int; v_owned int;
  v_locked int := 0; v_updated int; v_exp timestamptz; v_resp jsonb; r record;
BEGIN
  -- b. per-(user, show) lock
  PERFORM pg_advisory_xact_lock(hashtextextended(format('%s:%s', p_show, p_user), 0));

  -- a. read-only key check
  SELECT request_hash, response INTO v_req
    FROM booking_requests WHERE user_id = p_user AND idem_key = p_key;
  IF FOUND THEN
    IF v_req.request_hash <> p_hash THEN RETURN jsonb_build_object('code', 'KEY_MISMATCH'); END IF;
    RETURN jsonb_build_object('code', 'REPLAY', 'response', v_req.response);
  END IF;

  -- c. per-user limit
  SELECT max_seats_per_user INTO v_limit FROM shows WHERE show_id = p_show;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'SHOW_NOT_FOUND'); END IF;
  SELECT count(*) INTO v_owned FROM seats s
   WHERE s.show_id = p_show AND s.held_by = p_user AND s.seat_id <> ALL(p_seats)
     AND (s.status = 'BOOKED' OR (s.status = 'HELD' AND s.hold_expires_at > now()));
  IF v_owned + cardinality(p_seats) > v_limit THEN
    RETURN jsonb_build_object('code', 'LIMIT', 'limit', v_limit,
                              'remaining', greatest(v_limit - v_owned, 0));
  END IF;

  -- d. seat gate: lock free seats ascending
  FOR r IN SELECT seat_id FROM seats
            WHERE show_id = p_show AND seat_id = ANY(p_seats)
              AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))
            ORDER BY seat_id FOR UPDATE
  LOOP v_locked := v_locked + 1; END LOOP;
  IF v_locked <> cardinality(p_seats) THEN
    RETURN jsonb_build_object('code', 'NOT_ALL_FREE');   -- no writes yet: nothing to undo; the app classifies
  END IF;

  -- e. hold, guarded
  WITH upd AS (
    UPDATE seats SET status = 'HELD', hold_id = p_hold, held_by = p_user,
           hold_seat_count = cardinality(p_seats),
           hold_expires_at = now() + make_interval(secs => p_ttl_seconds)
     WHERE show_id = p_show AND seat_id = ANY(p_seats)
       AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= now()))
    RETURNING hold_expires_at)
  SELECT count(*), min(hold_expires_at) INTO v_updated, v_exp FROM upd;
  IF v_updated <> cardinality(p_seats) THEN
    RAISE EXCEPTION 'hold_seats: guarded update count mismatch' USING ERRCODE = 'BK002';  -- rolls back; app: 409 CONFLICT + alert
  END IF;

  -- f. key insert last, with the final response (the app maps these fields to the public contract)
  v_resp := jsonb_build_object('hold_id', p_hold, 'show_id', p_show, 'user_id', p_user,
                               'seats', to_jsonb(p_seats), 'status', 'HELD',
                               'expires_at', v_exp);
  INSERT INTO booking_requests (user_id, idem_key, request_hash, response)
  VALUES (p_user, p_key, p_hash, v_resp)
  ON CONFLICT (user_id, idem_key) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold_seats: key used concurrently' USING ERRCODE = 'BK001';  -- rolls back; app re-reads the key
  END IF;

  RETURN jsonb_build_object('code', 'OK', 'response', v_resp,
                            'expires_at_ms', (extract(epoch FROM v_exp) * 1000)::bigint);
END $$;

-- call (autocommit, one round trip):
-- SELECT hold_seats($1, $2, $3, $4, $5::text[], $6::uuid, $7);
```

The app maps return codes exactly as in §4.2 and §4.3: `REPLAY` replays, `KEY_MISMATCH` is the key-mismatch response, `LIMIT` is 409 `SEAT_LIMIT_EXCEEDED`, `SHOW_NOT_FOUND` is 404, `NOT_ALL_FREE` goes to classify, `BK001` re-reads the key, `BK002` is 409 `CONFLICT` + alert, and `55P03`, `40P01` and the rest follow the retry table. Returning a code commits an empty transaction, so every decline is write-free and holds no locks afterwards.

## Appendix B: in-process pieces

**Seat cache: write-through on commit, monotonic refresh.**

```ts
type Entry = { status: 'HELD' | 'BOOKED' | 'AVAILABLE'; owner?: number; until: number; writtenAt: number };
const SKEW_MS = 2000;

class SeatCache {
  private m = new Map<string, Entry>();                         // key = `${showId}:${seatId}`
  /** after COMMIT returns: seats just held or booked by us */
  writeThrough(k: string, status: 'HELD' | 'BOOKED', owner: number, untilMs: number) {
    this.m.set(k, { status, owner, until: status === 'BOOKED' ? Infinity : untilMs, writtenAt: Date.now() });
  }
  /** rows from a pre-check, classify read or state read. startedAt = Date.now() BEFORE the query was sent */
  merge(rows: Row[], startedAt: number) {
    for (const r of rows) {
      const k = `${r.show_id}:${r.seat_id}`;
      const cur = this.m.get(k);
      if (cur && cur.writtenAt >= startedAt) continue;          // newer than this query: it may not include it
      this.m.set(k, fromRow(r, startedAt));                     // AVAILABLE / HELD(until) / BOOKED(Infinity)
    }
  }
  rejects(keys: string[], userId: number, now = Date.now()) {
    return keys.some(k => {
      const e = this.m.get(k);
      if (!e || e.status === 'AVAILABLE') return false;
      if (e.status === 'HELD' && now >= e.until) { this.m.delete(k); return false; }
      return e.owner !== userId && (e.status === 'BOOKED' || now < e.until - SKEW_MS);
    });
  }
}
```

A snapshot row older than a write-through entry is skipped, so a refresh can never overwrite "taken" with a stale "free". A snapshot that started after the write-through includes the commit and may overwrite it, for example when a hold has expired.

**Per-seat gate: one request per seat at a time, sorted keys so it cannot deadlock in process.**

```ts
class KeyedGate {
  private tails = new Map<string, Promise<void>>();
  async run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const rel: Array<() => void> = [];
    for (const k of [...new Set(keys)].sort()) rel.push(await this.acquire(k));
    try { return await fn(); } finally { rel.reverse().forEach(r => r()); }
  }
  private async acquire(k: string) {
    const prev = this.tails.get(k) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(k, tail);
    await prev;
    return () => { release(); if (this.tails.get(k) === tail) this.tails.delete(k); };
  }
}
```

The gate wait is bounded by the request deadline; on expiry, check the cache and return 409 if the seat is taken, otherwise 429.

**Single-flight reader: each caller gets a result from a query that started after the call.**

```ts
class FreshSingleFlight<T> {
  private inFlight: Promise<T> | null = null;
  private queued: Promise<T> | null = null;
  constructor(private readonly load: () => Promise<T>) {}
  get(): Promise<T> {
    if (!this.inFlight) return this.run();
    if (!this.queued) {
      this.queued = this.inFlight.catch(() => {}).then(() => { this.queued = null; return this.run(); });
    }
    return this.queued;
  }
  private run(): Promise<T> {
    const p = this.load().finally(() => { if (this.inFlight === p) this.inFlight = null; });
    this.inFlight = p;
    return p;
  }
}
// one instance per show: new FreshSingleFlight(() => loadSeatsAndMergeIntoCache(showId))
```