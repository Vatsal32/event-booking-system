/**
 * On-sale stampede against a running instance, using only its public API.
 * Needs just the base URL and the admin key: no database credentials, no JWT secret.
 *
 *   ADMIN_KEY=... pnpm load:reserve --url https://<app> --mode stampede -n 2000
 *   pnpm load:reserve --mode hot -n 500        # 500 users racing for seat A1
 *   pnpm load:reserve --mode spread -n 500     # 500 users, one distinct seat each
 *   pnpm load:reserve --mode limit -n 10       # one user, 10 parallel reserves, limit 4
 *   pnpm load:reserve --mode idem -n 50        # one user, the same idempotency key 50 times
 *
 * Modes:
 *   stampede  ~30% of requests storm 5 hot seats, ~60% take distinct seats, ~10% are retries that
 *             resend an earlier request's exact key and body (the graders' on-sale scenario)
 *   hot | spread | limit | idem   as above
 *   cancel    release flow: reserve -> someone else can't take it -> someone else can't cancel it
 *   expiry    hold flow: hold -> others locked out -> owner converts one seat to a reservation ->
 *             wait past held_until -> the other seat is free again (and re-bookable), the
 *             reservation is not; cancelling the old hold resurrects nothing. Waits for the
 *             server's hold TTL (SEAT_LOCK_EXPIRATION_MINUTES, default 10 min); set it low
 *             (e.g. 0.5) on the server for a quick run. --max-wait caps the wait (default 15 min).
 *             -> the owner cancels (twice is harmless) -> the seat is re-bookable
 *
 * Flags: --url <base> (BASE_URL, else http://localhost:$PORT) | --admin-key <key> (ADMIN_KEY)
 *        -n <requests> (100) | --mode (hot) | --limit <per_user_limit> (4) | --seats <seat count>
 *        --concurrency <open connections> (500) | --timeout <ms per request> (30000)
 *        --prefix <test-user prefix> (lt) | --style spec|current (spec) | --env <file> (.env)
 *        --db-check  also verify the tables directly (needs DB_* / DATABASE_URL; for local runs)
 *        --max-wait <ms>  expiry mode: longest it will wait for a hold to expire (900000)
 *
 * Steps: admin token (POST /user/admin-token) -> test users + tokens (POST /user/test-tokens)
 * -> fresh show (POST /shows) -> /metrics snapshot -> fire every request at once
 * -> outcome distribution -> reconciliation via GET /shows/:id -> /metrics deltas -> PASS/FAIL.
 * Exits 0 on PASS, 1 on FAIL, 2 on setup errors. The last line is a one-line SUMMARY.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client, type ClientConfig } from 'pg';
import { Agent, setGlobalDispatcher } from 'undici';

/* ------------------------------------------------------------------- types */
type Mode = 'hot' | 'spread' | 'limit' | 'idem' | 'stampede' | 'cancel' | 'expiry';
type Json = Record<string, any>;
interface TestUser {
  id: number;
  username: string;
  token: string;
}
interface CallResult {
  status: number;
  json: Json;
  ms: number;
  err?: string;
}
interface Job {
  userIndex: number;
  seats: string[];
  key: string;
  kind: 'hot' | 'spread' | 'retry' | 'limit' | 'idem';
}

/* ------------------------------------------------------------- args / env */
const die = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(2);
};

function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!m) continue;
    let v = m[2].trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// pnpm may forward a literal "--"; drop it so parseArgs doesn't treat the rest as positionals
const { values: a } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    n: { type: 'string', short: 'n', default: '100' },
    mode: { type: 'string', default: 'hot' },
    url: { type: 'string' },
    'admin-key': { type: 'string' },
    style: { type: 'string', default: 'spec' },
    limit: { type: 'string', default: '4' },
    seats: { type: 'string' },
    concurrency: { type: 'string', default: '500' },
    timeout: { type: 'string', default: '120000' },
    prefix: { type: 'string', default: 'lt' },
    'db-check': { type: 'boolean', default: false },
    'max-wait': { type: 'string', default: '900000' },
    env: { type: 'string', default: '.env' },
  },
});

loadEnv(a.env as string);

const MAX_WAIT_MS = Number(a['max-wait']);
const MODES: Mode[] = ['hot', 'spread', 'limit', 'idem', 'stampede', 'cancel', 'expiry'];
const N = Number(a.n);
const MODE = a.mode as Mode;
const LIMIT = Number(a.limit);
const CONCURRENCY = Number(a.concurrency);
const TIMEOUT_MS = Number(a.timeout);
const PREFIX = a.prefix as string;
const HOT_SEATS = 5; // stampede: how many hot seats the storm targets
const SEATS = Number(a.seats ?? Math.max(N + 10, 50));
const BASE = (
  a.url ??
  process.env.BASE_URL ??
  `http://localhost:${process.env.PORT ?? 8080}`
).replace(/\/$/, '');
const ADMIN_KEY = (a['admin-key'] as string | undefined) ?? process.env.ADMIN_KEY;

if (!ADMIN_KEY) die('ADMIN_KEY not set (env, .env or --admin-key)');
if (!MODES.includes(MODE)) die(`--mode must be one of: ${MODES.join(' | ')}`);
if (!['spec', 'current'].includes(a.style as string))
  die('--style must be spec | current');
if (!Number.isInteger(N) || N < 1) die('-n must be a positive integer');
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1)
  die('--concurrency must be a positive integer');
if (!Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS < 1 || TIMEOUT_MS > 2_147_483_647)
  die('--timeout must be a whole number of milliseconds, e.g. 30000');
if (MODE === 'spread' && SEATS < N) die(`--seats must be >= ${N} for spread mode`);
if (MODE === 'stampede' && SEATS < N + HOT_SEATS)
  die(`--seats must be >= ${N + HOT_SEATS} for stampede mode`);
if (MODE === 'limit' && SEATS < N) die(`--seats must be >= ${N} for limit mode`);

setGlobalDispatcher(
  new Agent({
    connections: CONCURRENCY,
    pipelining: 1,
    connect: { timeout: TIMEOUT_MS },
  }),
);

/** 64-char hex idempotency key */
const newKey = () => createHash('sha256').update(randomUUID()).digest('hex');

/** request body, in the spec's shape (idempotency_key) or the camelCase alias */
const reserveBody = (seats: string[], key: string) =>
  a.style === 'current'
    ? { seats, idempotencyKey: key }
    : { seats, idempotency_key: key };

/* -------------------------------------------------------------------- HTTP */
async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<CallResult> {
  const t0 = performance.now();
  if (body) {
    headers = {
      ...headers,
      'Content-Type': 'application/json',
    };
  }

  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as Json; // empty body is fine
    return { status: res.status, json, ms: performance.now() - t0 };
  } catch (e) {
    // name/code plus the message (and the cause's), so failures are diagnosable from the output
    const err = e as {
      name?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    const kind = err.cause?.code ?? err.name ?? 'error';
    const detail = [err.message, err.cause?.message]
      .filter((m): m is string => Boolean(m))
      .join(' | ')
      .slice(0, 160);
    return {
      status: 0,
      json: {},
      ms: performance.now() - t0,
      err: detail ? `${kind}: ${detail}` : kind,
    };
  }
}

const text = (v: unknown): string =>
  Array.isArray(v) ? v.join('; ') : typeof v === 'string' ? v : '';
const describe = (r: CallResult): string => {
  if (r.status === 0) return `network error (${r.err})`;
  if (r.status >= 200 && r.status < 300) return String(r.status);
  const why = r.json.reason ?? r.json.error ?? text(r.json.message);
  return `${r.status} ${String(why ?? '').slice(0, 60)}`.trim();
};
const idOf = (j: Json) => j.reservation_id ?? j.reservationId ?? j.id;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ??
  0;

/* ----------------------------------------------------------------- metrics */
type Snapshot = Map<string, number>; // `${name}{sorted labels}` -> value

/** GET /metrics as a flat map, or null if it isn't reachable. Per replica only. */
async function metricsSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${BASE}/metrics`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const snap: Snapshot = new Map();
    for (const line of (await res.text()).split('\n')) {
      const m = line.match(/^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)/);
      if (m) snap.set(m[1] + (m[2] ?? ''), Number(m[3]));
    }
    return snap;
  } catch {
    return null;
  }
}

/** sum of value deltas for series of `name` whose labels contain all of `match` */
function delta(
  before: Snapshot,
  after: Snapshot,
  name: string,
  match: Record<string, string | RegExp> = {},
): number {
  let total = 0;
  for (const [series, value] of after) {
    if (!series.startsWith(`${name}{`) && series !== name) continue;
    const labels = Object.fromEntries(
      [...series.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    const ok = Object.entries(match).every(([k, want]) =>
      want instanceof RegExp ? want.test(labels[k] ?? '') : labels[k] === want,
    );
    if (ok) total += value - (before.get(series) ?? 0);
  }
  return total;
}

/* ---------------------------------------------------------------- db check */
function dbConfig(): ClientConfig {
  const sslOn = /^(1|true|yes)$/i.test(process.env.DB_SSL ?? '');
  const ssl = sslOn
    ? {
        rejectUnauthorized: true,
        ca: process.env.DB_CERT_PATH
          ? readFileSync(process.env.DB_CERT_PATH, 'utf8')
          : undefined,
      }
    : undefined;
  if (process.env.DATABASE_URL)
    return { connectionString: process.env.DATABASE_URL, ssl };
  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl,
  };
}

/** Optional (--db-check): verifies the tables directly. Needs DB_* / DATABASE_URL. */
async function dbChecks(
  showId: number,
  expectedReservations: number,
): Promise<{ lines: string[]; fails: string[] }> {
  const db = new Client(dbConfig());
  try {
    await db.connect();
    const one = async (sql: string, p: unknown[]) =>
      Number((await db.query(sql, p)).rows[0].n);
    const reservations = await one(
      `SELECT count(*)::int AS n FROM reservations WHERE show_id = $1`,
      [showId],
    );
    const orphans = await one(
      `SELECT count(*)::int AS n FROM reservations r
        WHERE r.show_id = $1 AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.reservation_id = r.reservation_id)`,
      [showId],
    );
    const wrongOwner = await one(
      `SELECT count(*)::int AS n FROM seats s JOIN reservations r ON r.reservation_id = s.reservation_id
        WHERE s.show_id = $1 AND s.reserved_by::text <> r.user_id`,
      [showId],
    );
    const overLimit = (
      await db.query(
        `SELECT reserved_by, count(*)::int AS n FROM seats
          WHERE show_id = $1
            AND (status = 'RESERVED' OR (status = 'HOLD' AND held_until > now()))
          GROUP BY reserved_by HAVING count(*) > $2`,
        [showId, LIMIT],
      )
    ).rows;
    const dupKeys = (
      await db.query(
        `SELECT user_id, count(*)::int AS n FROM reservations WHERE show_id = $1
          GROUP BY user_id, idempotency_key HAVING count(*) > 1`,
        [showId],
      )
    ).rows;

    const fails: string[] = [];
    if (reservations !== expectedReservations)
      fails.push(
        `db: expected ${expectedReservations} reservation row(s), found ${reservations}`,
      );
    if (orphans) fails.push(`db: ${orphans} reservation row(s) have no seats`);
    if (wrongOwner)
      fails.push(`db: ${wrongOwner} seat(s) owned by a different user than their reservation`);
    if (overLimit.length)
      fails.push(`db: ${overLimit.length} user(s) hold more than ${LIMIT} seats`);
    if (dupKeys.length)
      fails.push(`db: ${dupKeys.length} idempotency key(s) produced more than one reservation`);
    return {
      lines: [
        `reservations ${reservations} | orphans ${orphans} | owner mismatches ${wrongOwner} | users over limit ${overLimit.length} | duplicate keys ${dupKeys.length}`,
      ],
      fails,
    };
  } catch (e) {
    return {
      lines: [`(db check failed to run: ${(e as Error).message})`],
      fails: ['db check could not connect or query'],
    };
  } finally {
    await db.end().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------- setup */
async function adminToken(): Promise<string> {
  const r = await call('POST', '/user/admin-token', undefined, undefined, {
    'x-admin-key': ADMIN_KEY as string,
  });
  const token = r.json.accessToken;
  if (r.status !== 200 || typeof token !== 'string')
    die(`admin token failed: ${describe(r)}`);
  return token as string;
}

async function testUsers(admin: string, count: number): Promise<TestUser[]> {
  const r = await call('POST', '/user/test-tokens', admin, {
    count,
    prefix: PREFIX,
  });
  const users = r.json.users as TestUser[] | undefined;
  if (r.status !== 201 || !Array.isArray(users) || users.length < count)
    die(`creating ${count} test users failed: ${describe(r)}`);
  return users as TestUser[];
}

/**
 * --mode cancel: the release model, step by step (not a burst). Checks that only the owner can
 * cancel, that a released seat becomes cleanly re-bookable, and that state reconciles.
 */
async function runCancelScenario(admin: string): Promise<void> {
  const [a, b] = await testUsers(admin, 2);
  const created = await call('POST', '/shows', admin, {
    name: `burst-cancel-${Date.now()}`,
    seats: Array.from({ length: SEATS }, (_, i) => `A${i + 1}`),
    price_paise: 25000,
    per_user_limit: LIMIT,
  });
  if (created.status !== 201) die(`create show failed: ${describe(created)}`);
  const showId = Number(created.json.id ?? created.json.showId);
  console.log(`show ${showId} created with ${SEATS} seats`);

  const fails: string[] = [];
  const step = (label: string, r: CallResult, want: number) => {
    const okStep = r.status === want;
    console.log(`  ${okStep ? 'ok  ' : 'FAIL'} ${label}: ${describe(r)} (want ${want})`);
    if (!okStep) fails.push(`${label}: got ${describe(r)}, want ${want}`);
    return r;
  };
  const reserve = (u: TestUser, key: string) =>
    call('POST', `/shows/${showId}/reserve`, u.token, reserveBody(['A1'], key));
  const cancel = (u: TestUser, id: string) =>
    call('POST', `/reservations/${id}/cancel`, u.token);

  console.log('\n== release flow ==');
  const first = step('A reserves A1', await reserve(a, newKey()), 201);
  const id = String(idOf(first.json));
  step('B reserves A1 (taken)', await reserve(b, newKey()), 409);
  step("B cancels A's reservation", await cancel(b, id), 404);
  const released = step('A cancels', await cancel(a, id), 200);
  if (JSON.stringify(released.json.released_seats) !== JSON.stringify(['A1']))
    fails.push(`A's cancel released ${JSON.stringify(released.json.released_seats)}, want ["A1"]`);
  const again = step('A cancels again (harmless)', await cancel(a, id), 200);
  if ((again.json.released_seats ?? []).length !== 0)
    fails.push('second cancel released seats again');
  step('B reserves A1 (re-bookable)', await reserve(b, newKey()), 201);

  const state = await call('GET', `/shows/${showId}`);
  const counts = state.json.counts as
    | { available: number; held: number; confirmed: number }
    | undefined;
  const a1 = (state.json.seats as Array<{ seat_number: string; status: string }> | undefined)
    ?.find((x) => x.seat_number === 'A1');
  console.log(
    `\n== reconciliation (GET /shows/${showId}) == A1 ${a1?.status} | counts ${JSON.stringify(counts)} | total_seats ${state.json.total_seats}`,
  );
  if (a1?.status !== 'confirmed') fails.push(`A1 is ${a1?.status}, want confirmed (B's)`);
  if (!counts || counts.confirmed !== 1 || counts.held !== 0)
    fails.push(`expected exactly 1 confirmed seat, got ${JSON.stringify(counts)}`);
  if (
    counts &&
    counts.available + counts.held + counts.confirmed !== state.json.total_seats
  )
    fails.push('available + held + confirmed != total_seats');

  const result = fails.length ? 'FAIL' : 'PASS';
  console.log(fails.length ? `\nFAIL\n  - ${fails.join('\n  - ')}` : '\nPASS');
  console.log(`SUMMARY mode=cancel result=${result} steps=6`);
  process.exit(fails.length ? 1 : 0);
}

/**
 * --mode expiry: the hold lifecycle, step by step (not a burst). Waits past the hold's
 * held_until, so it takes as long as the server's hold TTL.
 */
async function runExpiryScenario(admin: string): Promise<void> {
  if (!Number.isInteger(MAX_WAIT_MS) || MAX_WAIT_MS < 0)
    die('--max-wait must be a whole number of milliseconds');
  const [a, b] = await testUsers(admin, 2);
  const created = await call('POST', '/shows', admin, {
    name: `burst-expiry-${Date.now()}`,
    seats: Array.from({ length: SEATS }, (_, i) => `A${i + 1}`),
    price_paise: 25000,
    per_user_limit: LIMIT,
  });
  if (created.status !== 201) die(`create show failed: ${describe(created)}`);
  const showId = Number(created.json.id ?? created.json.showId);
  console.log(`show ${showId} created with ${SEATS} seats`);

  const fails: string[] = [];
  const step = (label: string, r: CallResult, want: number) => {
    const okStep = r.status === want;
    console.log(`  ${okStep ? 'ok  ' : 'FAIL'} ${label}: ${describe(r)} (want ${want})`);
    if (!okStep) fails.push(`${label}: got ${describe(r)}, want ${want}`);
    return r;
  };
  const claim = (endpoint: 'hold' | 'reserve', u: TestUser, seats: string[]) =>
    call('POST', `/shows/${showId}/${endpoint}`, u.token, reserveBody(seats, newKey()));
  const seatState = async () => {
    const r = await call('GET', `/shows/${showId}`);
    const seats = new Map(
      ((r.json.seats ?? []) as Array<{ seat_number: string; status: string }>).map(
        (x) => [x.seat_number, x.status],
      ),
    );
    return { r, seats, counts: r.json.counts as Json | undefined };
  };
  const expectSeats = async (label: string, want: Record<string, string>) => {
    const { seats, counts, r } = await seatState();
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, seats.get(k)]));
    const match = Object.entries(want).every(([k, v]) => seats.get(k) === v);
    const total = r.json.total_seats as number | undefined;
    const reconciles =
      !!counts && counts.available + counts.held + counts.confirmed === total;
    console.log(
      `  ${match && reconciles ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)} | counts ${JSON.stringify(counts)} | total_seats ${total}`,
    );
    if (!match) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    if (!reconciles) fails.push(`${label}: available + held + confirmed != total_seats`);
    return match;
  };

  console.log('\n== while the hold is active ==');
  const hold = step('A holds A1 + A2', await claim('hold', a, ['A1', 'A2']), 201);
  const holdId = String(idOf(hold.json));
  const heldUntil = Date.parse(String(hold.json.held_until));
  if (hold.json.status !== 'held' || Number.isNaN(heldUntil))
    fails.push(`hold response should have status "held" and held_until, got ${JSON.stringify(hold.json)}`);
  await expectSeats('state after the hold', { A1: 'held', A2: 'held' });
  step('B holds A1 (held by A)', await claim('hold', b, ['A1']), 409);
  step('B reserves A2 (held by A)', await claim('reserve', b, ['A2']), 409);
  step('A reserves A1 (own hold -> confirmed)', await claim('reserve', a, ['A1']), 201);
  await expectSeats('state after A reserves A1', { A1: 'confirmed', A2: 'held' });

  if (Number.isNaN(heldUntil)) return finishExpiry(fails);
  const waitMs = heldUntil - Date.now() + 3000; // +3s for clock differences
  if (waitMs > MAX_WAIT_MS)
    die(
      `the hold expires in ${Math.round(waitMs / 1000)}s, more than --max-wait ${Math.round(MAX_WAIT_MS / 1000)}s; lower SEAT_LOCK_EXPIRATION_MINUTES on the server or raise --max-wait`,
    );
  console.log(`\n== waiting ${Math.max(0, Math.round(waitMs / 1000))}s for the hold to expire (held_until ${new Date(heldUntil).toISOString()}) ==`);
  for (let left = waitMs; left > 0; left -= 30_000) {
    await new Promise((r) => setTimeout(r, Math.min(left, 30_000)));
    if (left > 30_000) console.log(`  ${Math.round((left - 30_000) / 1000)}s left`);
  }

  console.log('\n== after the hold expired ==');
  // poll briefly in case the server's clock is a little behind ours
  let expired = false;
  for (let i = 0; i < 10 && !expired; i++) {
    const { seats } = await seatState();
    expired = seats.get('A2') === 'available';
    if (!expired) await new Promise((r) => setTimeout(r, 3000));
  }
  await expectSeats('expired hold is free, the reservation is not', {
    A1: 'confirmed',
    A2: 'available',
  });
  step('B reserves A2 (expired hold, re-bookable)', await claim('reserve', b, ['A2']), 201);
  step('A reserves A2 (now B\'s)', await claim('reserve', a, ['A2']), 409);
  const cancel = step(
    "A cancels the old hold",
    await call('POST', `/reservations/${holdId}/cancel`, a.token),
    200,
  );
  if ((cancel.json.released_seats ?? []).length !== 0)
    fails.push(
      `cancelling the expired hold released ${JSON.stringify(cancel.json.released_seats)}; it must not touch A1 (now A's reservation) or A2 (now B's)`,
    );
  await expectSeats('final state', { A1: 'confirmed', A2: 'confirmed' });
  return finishExpiry(fails);
}

function finishExpiry(fails: string[]): void {
  const result = fails.length ? 'FAIL' : 'PASS';
  console.log(fails.length ? `\nFAIL\n  - ${fails.join('\n  - ')}` : '\nPASS');
  console.log(`SUMMARY mode=expiry result=${result}`);
  process.exit(fails.length ? 1 : 0);
}

/** The requests to fire, per mode. */
function buildJobs(): Job[] {
  const seat = (i: number) => `A${i + 1}`;
  switch (MODE) {
    case 'hot':
      return Array.from({ length: N }, (_, i) => ({
        userIndex: i,
        seats: ['A1'],
        key: newKey(),
        kind: 'hot' as const,
      }));
    case 'spread':
      return Array.from({ length: N }, (_, i) => ({
        userIndex: i,
        seats: [seat(i)],
        key: newKey(),
        kind: 'spread' as const,
      }));
    case 'limit':
      return Array.from({ length: N }, (_, i) => ({
        userIndex: 0,
        seats: [seat(i)],
        key: newKey(),
        kind: 'limit' as const,
      }));
    case 'idem': {
      const key = newKey();
      return Array.from({ length: N }, () => ({
        userIndex: 0,
        seats: ['A1'],
        key,
        kind: 'idem' as const,
      }));
    }
    case 'cancel':
    case 'expiry':
      return []; // handled by runCancelScenario / runExpiryScenario
    case 'stampede': {
      const hot = Math.max(HOT_SEATS, Math.round(N * 0.3));
      const retries = Math.round(N * 0.1);
      const spread = Math.max(0, N - hot - retries);
      const originals: Job[] = [
        ...Array.from({ length: hot }, (_, i) => ({
          userIndex: i,
          seats: [seat(i % HOT_SEATS)], // A1..A5
          key: newKey(),
          kind: 'hot' as const,
        })),
        ...Array.from({ length: spread }, (_, i) => ({
          userIndex: hot + i,
          seats: [seat(HOT_SEATS + i)], // A6..
          key: newKey(),
          kind: 'spread' as const,
        })),
      ];
      // retries resend an earlier request's exact user, key and body
      const step = Math.max(1, Math.floor(originals.length / Math.max(1, retries)));
      const retryJobs = Array.from({ length: retries }, (_, i) => ({
        ...originals[(i * step) % originals.length],
        kind: 'retry' as const,
      }));
      return [...originals, ...retryJobs];
    }
  }
}

/* -------------------------------------------------------------------- main */
async function main(): Promise<void> {
  console.log(
    `target ${BASE} | mode=${MODE} | n=${N} | concurrency=${CONCURRENCY} | style=${a.style}`,
  );

  const admin = await adminToken();
  if (MODE === 'cancel') return runCancelScenario(admin);
  if (MODE === 'expiry') return runExpiryScenario(admin);
  const jobs = buildJobs();
  const userCount = Math.max(...jobs.map((j) => j.userIndex)) + 1;
  const users = await testUsers(admin, userCount);
  console.log(`test users ready: ${users.length} (prefix "${PREFIX}")`);

  const created = await call('POST', '/shows', admin, {
    name: `burst-${MODE}-${Date.now()}`,
    seats: Array.from({ length: SEATS }, (_, i) => `A${i + 1}`),
    price_paise: 25000,
    per_user_limit: LIMIT,
  });
  if (created.status !== 201) die(`create show failed: ${describe(created)}`);
  const showId = Number(
    created.json.showId ?? created.json.id ?? created.json.show_id,
  );
  if (!Number.isInteger(showId))
    die(`no show id in create response: ${JSON.stringify(created.json).slice(0, 200)}`);
  console.log(`show ${showId} created with ${SEATS} seats (per_user_limit=${LIMIT})`);

  const before = await metricsSnapshot();

  console.log(`firing ${jobs.length} simultaneous requests...`);
  const t0 = performance.now();
  const results = await Promise.all(
    jobs.map((job) =>
      call(
        'POST',
        `/shows/${showId}/reserve`,
        users[job.userIndex].token,
        reserveBody(job.seats, job.key),
      ),
    ),
  );
  const wall = performance.now() - t0;

  /* --------------------------------------------------------------- outcomes */
  const dist = new Map<string, number>();
  for (const r of results) dist.set(describe(r), (dist.get(describe(r)) ?? 0) + 1);
  const ms = results.map((r) => r.ms).sort((x, y) => x - y);
  console.log(
    `\n== outcome distribution (${(wall / 1000).toFixed(2)}s, ${(jobs.length / (wall / 1000)).toFixed(0)} req/s) ==`,
  );
  for (const [k, v] of [...dist].sort()) console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log(
    `  latency ms  p50 ${pct(ms, 50).toFixed(0)}  p95 ${pct(ms, 95).toFixed(0)}  p99 ${pct(ms, 99).toFixed(0)}`,
  );

  const fails: string[] = [];
  const isOk = (r: CallResult) => r.status >= 200 && r.status < 300;
  const count = (fn: (r: CallResult) => boolean) => results.filter(fn).length;
  const ok = count(isOk);
  const conflicts = count((r) => r.status === 409);
  const busy = count((r) => r.status === 429);
  const fiveXX = count((r) => r.status >= 500);
  const network = count((r) => r.status === 0);
  if (fiveXX) fails.push(`${fiveXX} responses were 5xx`);
  if (network) fails.push(`${network} network errors / timeouts`);

  // reservation ids seen per idempotency key and per seat
  const idsByKey = new Map<string, Set<string>>();
  const idsBySeat = new Map<string, Set<string>>();
  results.forEach((r, i) => {
    if (!isOk(r)) return;
    const id = String(idOf(r.json));
    const job = jobs[i];
    (idsByKey.get(job.key) ?? idsByKey.set(job.key, new Set()).get(job.key)!).add(id);
    for (const s of job.seats)
      (idsBySeat.get(s) ?? idsBySeat.set(s, new Set()).get(s)!).add(id);
  });
  const reservationIds = new Set([...idsByKey.values()].flatMap((s) => [...s]));
  for (const [key, ids] of idsByKey)
    if (ids.size > 1)
      fails.push(`idempotency key ${key.slice(0, 8)}… produced ${ids.size} reservations`);
  for (const [s, ids] of idsBySeat)
    if (ids.size > 1) fails.push(`seat ${s} confirmed to ${ids.size} reservations`);

  let expectedClaimed: number;
  if (MODE === 'hot') {
    expectedClaimed = 1;
    if (ok !== 1) fails.push(`expected exactly 1 success, got ${ok}`);
    if (conflicts !== N - 1) fails.push(`expected ${N - 1} x 409, got ${conflicts}`);
  } else if (MODE === 'spread') {
    expectedClaimed = N;
    if (ok !== N) fails.push(`expected ${N} successes, got ${ok}`);
  } else if (MODE === 'limit') {
    expectedClaimed = Math.min(LIMIT, N);
    if (ok !== expectedClaimed)
      fails.push(`expected ${expectedClaimed} successes (per-user limit), got ${ok}`);
    if (conflicts !== N - expectedClaimed)
      fails.push(`expected ${N - expectedClaimed} x 409, got ${conflicts}`);
  } else if (MODE === 'idem') {
    expectedClaimed = 1;
    if (ok !== N) fails.push(`expected ${N} successful responses, got ${ok}`);
    if (reservationIds.size !== 1)
      fails.push(`expected one reservation id, got ${reservationIds.size}`);
  } else {
    // stampede: every hot seat has exactly one winner, every spread seat is confirmed
    const hotSeats = Array.from({ length: HOT_SEATS }, (_, i) => `A${i + 1}`);
    for (const s of hotSeats)
      if ((idsBySeat.get(s)?.size ?? 0) !== 1)
        fails.push(`hot seat ${s}: expected exactly 1 winner, got ${idsBySeat.get(s)?.size ?? 0}`);
    const spreadJobs = jobs.filter((j) => j.kind === 'spread');
    const unconfirmed = spreadJobs.filter((j) => !idsBySeat.has(j.seats[0])).length;
    if (unconfirmed) fails.push(`${unconfirmed} distinct-seat request(s) were not confirmed`);
    const hotLosers = results.filter(
      (r, i) => jobs[i].kind === 'hot' && !isOk(r) && r.status !== 409,
    ).length;
    if (hotLosers) fails.push(`${hotLosers} hot-seat losers got something other than 409`);
    expectedClaimed = HOT_SEATS + spreadJobs.length;
  }

  /* --------------------------------------------- reconciliation (the API) */
  const state = await call('GET', `/shows/${showId}`);
  const counts = state.json.counts as
    | { available: number; held: number; confirmed: number }
    | undefined;
  const total = state.json.total_seats as number | undefined;
  if (state.status !== 200 || !counts || total === undefined) {
    fails.push(`GET /shows/${showId} -> ${describe(state)}`);
  } else {
    const claimed = counts.held + counts.confirmed;
    console.log(
      `\n== reconciliation (GET /shows/${showId}) == available ${counts.available} + held ${counts.held} + confirmed ${counts.confirmed} = ${counts.available + counts.held + counts.confirmed} | total_seats ${total}`,
    );
    if (counts.available + counts.held + counts.confirmed !== total)
      fails.push('available + held + confirmed != total_seats');
    if (total !== SEATS) fails.push(`total_seats ${total}, expected ${SEATS}`);
    if (claimed !== expectedClaimed)
      fails.push(`expected ${expectedClaimed} claimed seats, found ${claimed}`);
    if (counts.confirmed !== reservationIds.size)
      fails.push(
        `confirmed seats (${counts.confirmed}) != distinct reservations in responses (${reservationIds.size})`,
      );
  }

  /* ------------------------------------------------- metrics (one replica) */
  const after = before ? await metricsSnapshot() : null;
  if (before && after) {
    const d = (name: string, match: Record<string, string | RegExp> = {}) =>
      delta(before, after, name, match);
    const reserveRoute = { route: '/shows/:id/reserve' };
    const declined = (reason: string) =>
      d('reservations_declined_total', { reason, action: 'reserve' });
    const replays = ok - reservationIds.size;
    console.log('\n== /metrics deltas (this replica only) ==');
    console.log(
      `  confirmed +${d('reservations_confirmed_total')} (new reservations in responses: ${reservationIds.size})`,
    );
    console.log(
      `  declined  seat_taken +${declined('seat_taken')} | per_user_limit +${declined('per_user_limit')} | idempotent_replay +${declined('idempotent_replay')} (replays in responses: ${replays}) | idempotency_mismatch +${declined('idempotency_mismatch')} | request_in_progress +${declined('request_in_progress')} | server_busy +${declined('server_busy')}`,
    );
    console.log(
      `  http      201 +${d('http_requests_total', { ...reserveRoute, status_code: '201' })} | 409 +${d('http_requests_total', { ...reserveRoute, status_code: '409' })} | 429 +${d('http_requests_total', { ...reserveRoute, status_code: '429' })} | 5xx +${d('http_requests_total', { status_code: /^5/ })}`,
    );
    if (d('reservations_confirmed_total') !== reservationIds.size)
      console.log(
        '  note: confirmed delta differs from the responses; expected if several replicas serve traffic',
      );
  } else {
    console.log('\n(/metrics not reachable: metrics deltas skipped)');
  }

  /* ---------------------------------------------------- optional DB check */
  if (a['db-check']) {
    const report = await dbChecks(showId, reservationIds.size);
    console.log(`\n== database checks ==\n  ${report.lines.join('\n  ')}`);
    fails.push(...report.fails);
  }

  const result = fails.length ? 'FAIL' : 'PASS';
  console.log(fails.length ? `\nFAIL\n  - ${fails.join('\n  - ')}` : '\nPASS');
  console.log(
    `SUMMARY mode=${MODE} result=${result} requests=${jobs.length} 2xx=${ok} 409=${conflicts} 429=${busy} 5xx=${fiveXX} network=${network} wall=${(wall / 1000).toFixed(2)}s p99=${pct(ms, 99).toFixed(0)}ms`,
  );
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
