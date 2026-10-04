import { QueryFailedError } from 'typeorm';

/**
 * How a database/infrastructure error should be treated. Shared by the global exception filter
 * (which turns it into a deliberate response) and the readiness probe (busy != down).
 *   SERVER_BUSY       overloaded: pool wait/connect timeout, too many connections, statement or
 *                     lock timeout, deadlock, serialization failure. A retry may well succeed.
 *   DB_UNAVAILABLE    unreachable or the connection dropped.
 *   INVALID_INPUT     SQLSTATE class 22 (bad data).
 *   CONFLICT          23505 unique violation.
 *   INVALID_REFERENCE 23503 foreign key violation.
 */
export type DbErrorKind =
  | 'SERVER_BUSY'
  | 'DB_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'INVALID_REFERENCE';

const BUSY_PG_CODES = new Set([
  '53300', // too_many_connections
  '57014', // query_canceled (statement_timeout)
  '55P03', // lock_not_available (lock_timeout / NOWAIT)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);
const BUSY_MESSAGES = [
  'timeout exceeded when trying to connect', // pg pool: no free connection in time
  'Connection terminated due to connection timeout', // pg: opening a new connection took too long
];

const DB_DOWN_PG_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);
const DB_DOWN_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
]);
const DB_DOWN_MESSAGES = ['Connection terminated unexpectedly'];

/** The kind of a database/infrastructure error, or undefined if it isn't one (a genuine bug). */
export function classifyDbError(e: unknown): DbErrorKind | undefined {
  const pgCode = getPgCode(e);
  const nodeCode = getNodeCode(e);
  const message = e instanceof Error ? e.message : '';

  if (
    (pgCode && BUSY_PG_CODES.has(pgCode)) ||
    BUSY_MESSAGES.some((m) => message.includes(m))
  ) {
    return 'SERVER_BUSY';
  }
  if (
    (pgCode && (pgCode.startsWith('08') || DB_DOWN_PG_CODES.has(pgCode))) ||
    (nodeCode && DB_DOWN_NODE_CODES.has(nodeCode)) ||
    DB_DOWN_MESSAGES.some((m) => message.includes(m))
  ) {
    return 'DB_UNAVAILABLE';
  }
  if (pgCode?.startsWith('22')) return 'INVALID_INPUT';
  if (pgCode === '23505') return 'CONFLICT';
  if (pgCode === '23503') return 'INVALID_REFERENCE';
  return undefined;
}

/** A short, bounded code for metrics: SQLSTATE, Node error code, pool_timeout, or unknown. */
export function errorCode(e: unknown): string {
  const pgCode = getPgCode(e);
  if (pgCode) return pgCode;
  const nodeCode = getNodeCode(e);
  if (nodeCode) return nodeCode;
  const message = e instanceof Error ? e.message : '';
  if (BUSY_MESSAGES.some((m) => message.includes(m))) return 'pool_timeout';
  if (DB_DOWN_MESSAGES.some((m) => message.includes(m))) {
    return 'connection_terminated';
  }
  return 'unknown';
}

/** SQLSTATE from a TypeORM QueryFailedError or a raw pg error (5 characters, e.g. '53300'). */
export function getPgCode(e: unknown): string | undefined {
  const source =
    e instanceof QueryFailedError
      ? (e.driverError as { code?: unknown })
      : (e as { code?: unknown } | null);
  const code = source?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

/** Node.js system error code (e.g. 'ECONNRESET'), also when wrapped in `cause`. */
export function getNodeCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  for (const code of [err?.code, err?.cause?.code]) {
    if (typeof code === 'string' && code.startsWith('E')) return code;
  }
  return undefined;
}
