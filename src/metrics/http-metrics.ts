import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { METRICS } from './metric-names.js';

interface HookRequest {
  method: string;
  url: string;
  routeOptions?: { url?: string };
}
interface HookReply {
  statusCode: number;
  elapsedTime: number; // ms
}


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
    @InjectMetric(METRICS.httpResponsesByClass)
    private readonly byClass: Counter<string>,
  ) {}

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
          route: request.routeOptions?.url ?? 'unmatched',
          status_code: String(reply.statusCode),
        };
        this.requests.inc(labels);
        this.duration.observe(labels, reply.elapsedTime / 1000);
        this.byClass.inc({ status_class: `${Math.floor(reply.statusCode / 100)}xx` });
      },
    );

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

function isScrape(request: HookRequest): boolean {
  return request.url === '/metrics' || request.url.startsWith('/metrics?');
}
