import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { METRICS } from './metric-names.js';

/** The parts of a Fastify request/reply these hooks read. */
interface HookRequest {
  method: string;
  url: string;
  routeOptions?: { url?: string };
}
interface HookReply {
  statusCode: number;
  elapsedTime: number; // ms
}

/**
 * Counts every HTTP response by method, route template and status, records its latency, and
 * tracks requests in flight. Registered as Fastify hooks (see main.ts) rather than a Nest
 * interceptor, so responses from guards (401/403) and from the exception filter are counted too.
 */
@Injectable()
export class HttpMetrics {
  private readonly inFlight = new WeakSet<object>();

  constructor(
    @InjectMetric(METRICS.httpRequestsTotal)
    private readonly requests: Counter<string>,
    @InjectMetric(METRICS.httpRequestDuration)
    private readonly duration: Histogram<string>,
    @InjectMetric(METRICS.httpRequestsInFlight)
    private readonly inFlightGauge: Gauge<string>,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify's overloaded addHook
  register(fastify: { addHook: (...args: any[]) => unknown }): void {
    fastify.addHook('onRequest', async (request: HookRequest) => {
      if (isScrape(request)) return;
      this.inFlight.add(request);
      this.inFlightGauge.inc();
    });

    fastify.addHook(
      'onResponse',
      async (request: HookRequest, reply: HookReply) => {
        if (isScrape(request)) return;
        this.leave(request);
        const labels = {
          method: request.method,
          // the route template (e.g. /shows/:id/reserve), never the raw URL, so label values stay bounded
          route: request.routeOptions?.url ?? 'unmatched',
          status_code: String(reply.statusCode),
        };
        this.requests.inc(labels);
        this.duration.observe(labels, reply.elapsedTime / 1000);
      },
    );

    // client disconnected before a response was sent
    fastify.addHook('onRequestAbort', async (request: HookRequest) => {
      this.leave(request);
    });
  }

  private leave(request: HookRequest): void {
    if (this.inFlight.delete(request)) {
      this.inFlightGauge.dec();
    }
  }
}

/** Prometheus scrapes are left out, so they don't show up in the burst numbers. */
function isScrape(request: HookRequest): boolean {
  return request.url === '/metrics' || request.url.startsWith('/metrics?');
}
