import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** An incoming id is reused only if it's short and plain, so it can't inject anything into logs. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Correlation id for every request (pino-http genReqId): the caller's x-request-id if it is safe,
 * otherwise a fresh UUID. It is attached to every log line of the request (req.id) and returned to
 * the client in the x-request-id response header, so a response, its logs and its traces can be
 * matched up.
 */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && SAFE_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
