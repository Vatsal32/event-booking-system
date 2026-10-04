/**
 * claim_seats(): the whole hold / reserve decision in one database call (one round trip, one
 * implicit transaction). Installed at startup by ReserveSeatsInstaller.
 *
 * Seat states: AVAILABLE -> HOLD (lapses at held_until) -> RESERVED (permanent).
 *   p_mode = 'HOLD'    : free seats -> HOLD, held_until = now() + ttl
 *   p_mode = 'RESERVE' : free seats, or seats the caller holds (unexpired) -> RESERVED, held_until = NULL
 * "Free" means AVAILABLE, or a HOLD whose held_until has passed. Nothing ever leaves RESERVED.
 *
 * Order of work, identical for every caller (so no deadlocks):
 *   per-(show, user) advisory lock -> idempotency check -> per-user limit
 *   -> seat rows locked in seat_number order -> reservation insert -> seat update.
 * Every decline returns before anything is written. Multi-seat requests are all-or-nothing.
 *
 * Outcomes: CREATED | REPLAY | IDEMPOTENCY_MISMATCH | LIMIT_EXCEEDED | SEAT_TAKEN
 *           | SEAT_NOT_FOUND | SHOW_NOT_FOUND
 * Errors the caller must map: 55P03 (seat row locked by another request, or the advisory
 * lock wait hit lock_timeout), 23505 on uq_reservations_user_idem (same key used for two
 * requests at the same moment).
 */
export const CLAIM_SEATS_FUNCTION_SQL = `
DROP FUNCTION IF EXISTS reserve_seats(bigint, bigint, text[], text, text, int);

CREATE OR REPLACE FUNCTION claim_seats(
  p_mode         text,
  p_show_id      bigint,
  p_user_id      bigint,
  p_seats        text[],
  p_idem_key     text,
  p_request_hash text,
  p_ttl_seconds  int
)
RETURNS TABLE (
  outcome        text,
  reservation_id bigint,
  seat_numbers   text[],
  amount_paise   bigint,
  expires_at     timestamptz
)
LANGUAGE plpgsql
VOLATILE
SET lock_timeout = '1s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_n          int := coalesce(cardinality(p_seats), 0);
  v_limit      int;
  v_price      bigint;
  v_prev       record;
  v_owned      int;
  v_seat_ids   bigint[];
  v_res_id     bigint;
  v_held_until timestamptz;
BEGIN
  IF p_mode NOT IN ('HOLD', 'RESERVE') THEN
    RAISE EXCEPTION 'claim_seats: unknown mode %', p_mode;
  END IF;
  -- only a hold expires; a reservation is permanent
  IF p_mode = 'HOLD' THEN
    v_held_until := now() + make_interval(secs => p_ttl_seconds);
  END IF;

  -- 1. show
  SELECT sh.per_user_limit, sh.price_paise
    INTO v_limit, v_price
    FROM shows sh
   WHERE sh.show_id = p_show_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'SHOW_NOT_FOUND'::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  -- 2. one request at a time per (show, user); other users never wait on this lock.
  --    This function is VOLATILE, so every statement below takes a fresh snapshot and
  --    sees the commit of whichever request held this lock before us.
  PERFORM pg_advisory_xact_lock(hashtextextended(format('%s:%s', p_show_id, p_user_id), 0));

  -- 3. idempotency: replay the stored result, or reject the same key with a different body
  --    (the hash includes the mode, so reusing a hold's key on /reserve is a mismatch)
  SELECT r.request_hash, r.reservation_id, r.seat_numbers, r.amount_paise, r.expires_at
    INTO v_prev
    FROM reservations r
   WHERE r.user_id = p_user_id::text
     AND r.idempotency_key = p_idem_key;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN QUERY SELECT 'IDEMPOTENCY_MISMATCH'::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT 'REPLAY'::text, v_prev.reservation_id::bigint, v_prev.seat_numbers::text[],
                          v_prev.amount_paise::bigint, v_prev.expires_at::timestamptz;
    END IF;
    RETURN;
  END IF;

  -- 4. per-user limit: seats the user already owns (RESERVED, or an unexpired HOLD) outside
  --    this request, plus this request. Turning your own hold into a reservation adds nothing.
  SELECT count(*)
    INTO v_owned
    FROM seats s
   WHERE s.show_id = p_show_id
     AND s.reserved_by = p_user_id
     AND (s.status = 'RESERVED'
          OR (s.status = 'HOLD' AND s.held_until > now()))
     AND s.seat_number <> ALL (p_seats);
  IF v_owned + v_n > v_limit THEN
    RETURN QUERY SELECT 'LIMIT_EXCEEDED'::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::timestamptz;
    RETURN;
  END IF;

  -- 5. seat gate: lock only seats this request may take, in seat_number order.
  --    A matching seat locked by another in-flight request raises 55P03 immediately (NOWAIT).
  --    A seat someone else holds or has reserved doesn't match, so it is simply not returned.
  SELECT array_agg(locked.seat_id)
    INTO v_seat_ids
    FROM (
      SELECT s.seat_id
        FROM seats s
       WHERE s.show_id = p_show_id
         AND s.seat_number = ANY (p_seats)
         AND (s.status = 'AVAILABLE'
              OR (s.status = 'HOLD' AND s.held_until <= now())
              OR (p_mode = 'RESERVE'
                  AND s.status = 'HOLD'
                  AND s.reserved_by = p_user_id
                  AND s.held_until > now()))
       ORDER BY s.seat_number
         FOR UPDATE NOWAIT
    ) AS locked;

  IF coalesce(cardinality(v_seat_ids), 0) <> v_n THEN
    IF (SELECT count(*) FROM seats s
         WHERE s.show_id = p_show_id AND s.seat_number = ANY (p_seats)) < v_n THEN
      RETURN QUERY SELECT 'SEAT_NOT_FOUND'::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT 'SEAT_TAKEN'::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::timestamptz;
    END IF;
    RETURN;   -- nothing written; row locks are released when the call ends
  END IF;

  -- 6. write (only reached once every check has passed)
  INSERT INTO reservations (show_id, user_id, idempotency_key, request_hash, kind,
                            seat_numbers, amount_paise, expires_at)
  VALUES (p_show_id, p_user_id::text, p_idem_key, p_request_hash, p_mode,
          p_seats, v_price * v_n, v_held_until)
  RETURNING reservations.reservation_id INTO v_res_id;

  -- two literal branches, so the enum value never needs a cast to TypeORM's enum type name
  IF p_mode = 'HOLD' THEN
    UPDATE seats s
       SET status         = 'HOLD',
           reserved_by    = p_user_id,
           held_until     = v_held_until,
           reservation_id = v_res_id,
           updated_at     = now()
     WHERE s.show_id = p_show_id
       AND s.seat_id = ANY (v_seat_ids);
  ELSE
    UPDATE seats s
       SET status         = 'RESERVED',
           reserved_by    = p_user_id,
           held_until     = NULL,
           reservation_id = v_res_id,
           updated_at     = now()
     WHERE s.show_id = p_show_id
       AND s.seat_id = ANY (v_seat_ids);
  END IF;

  RETURN QUERY SELECT 'CREATED'::text, v_res_id, p_seats, v_price * v_n, v_held_until;
END
$fn$;
`;

/**
 * cancel_reservation(): the owner releases the seats of one of their holds or reservations, in one
 * database call. Installed at startup by ReserveSeatsInstaller.
 *
 * Only seats still linked to this reservation and owned by this user are released, so a seat that
 * someone else has taken since (e.g. after the hold expired) is never touched. Lock order matches
 * claim_seats (per-(show, user) advisory lock -> seat rows by seat_number -> reservation row), so
 * the two can never deadlock. Cancelling twice is harmless: the second call releases nothing.
 *
 * Outcomes: CANCELLED | ALREADY_CANCELLED | NOT_FOUND (no such reservation for this user)
 * Errors the caller must map: 55P03 (lock_timeout on the advisory lock or a seat row).
 */
export const CANCEL_RESERVATION_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION cancel_reservation(
  p_reservation_id bigint,
  p_user_id        bigint
)
RETURNS TABLE (
  outcome        text,
  show_id        bigint,
  kind           text,
  released_seats text[]
)
LANGUAGE plpgsql
VOLATILE
SET lock_timeout = '1s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_show_id  bigint;
  v_kind     text;
  v_released text[];
BEGIN
  -- 1. the reservation must exist and belong to this user (someone else's id looks the same as none)
  SELECT r.show_id, r.kind
    INTO v_show_id, v_kind
    FROM reservations r
   WHERE r.reservation_id = p_reservation_id
     AND r.user_id = p_user_id::text;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::bigint, NULL::text, NULL::text[];
    RETURN;
  END IF;

  -- 2. same per-(show, user) lock as claim_seats: this user's claims and cancels run one at a time
  PERFORM pg_advisory_xact_lock(hashtextextended(format('%s:%s', v_show_id, p_user_id), 0));

  -- 3. already cancelled (re-read after the lock: a parallel cancel may just have finished)
  IF (SELECT r.cancelled_at IS NOT NULL FROM reservations r
       WHERE r.reservation_id = p_reservation_id) THEN
    RETURN QUERY SELECT 'ALREADY_CANCELLED'::text, v_show_id, v_kind, ARRAY[]::text[];
    RETURN;
  END IF;

  -- 4. release only seats still linked to this reservation and owned by this user,
  --    locked in seat_number order like claim_seats
  WITH locked AS (
    SELECT s.seat_id, s.seat_number
      FROM seats s
     WHERE s.show_id = v_show_id
       AND s.reservation_id = p_reservation_id
       AND s.reserved_by = p_user_id
     ORDER BY s.seat_number
       FOR UPDATE
  ), released AS (
    UPDATE seats s
       SET status         = 'AVAILABLE',
           reserved_by    = NULL,
           held_until     = NULL,
           reservation_id = NULL,
           updated_at     = now()
      FROM locked l
     WHERE s.show_id = v_show_id
       AND s.seat_id = l.seat_id
    RETURNING l.seat_number
  )
  SELECT coalesce(array_agg(seat_number ORDER BY seat_number), ARRAY[]::text[])
    INTO v_released
    FROM released;

  -- 5. mark the reservation cancelled
  UPDATE reservations r
     SET cancelled_at = now()
   WHERE r.reservation_id = p_reservation_id;

  RETURN QUERY SELECT 'CANCELLED'::text, v_show_id, v_kind, v_released;
END
$fn$;
`;
