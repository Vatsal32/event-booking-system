import { Global, Module } from '@nestjs/common';
import {
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { DURATION_BUCKETS, METRICS } from './metric-names.js';
import { HttpMetrics } from './http-metrics.js';
import { MetricsInitializer } from './metrics-initializer.js';
import { SeatStateMetrics } from './seat-state-metrics.js';

const metricProviders = [
  // HTTP, every route
  makeCounterProvider({
    name: METRICS.httpRequestsTotal,
    help: 'HTTP responses by method, route template and status code',
    labelNames: ['method', 'route', 'status_code'],
  }),
  makeHistogramProvider({
    name: METRICS.httpRequestDuration,
    help: 'HTTP response time in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DURATION_BUCKETS,
  }),
  makeCounterProvider({
    name: METRICS.httpResponsesByClass,
    help: 'HTTP responses by status class (2xx, 3xx, 4xx, 5xx); every class starts at 0, so a 5xx filter always exists',
    labelNames: ['status_class'],
  }),
  makeGaugeProvider({
    name: METRICS.httpRequestsInFlight,
    help: 'HTTP requests currently being processed',
  }),

  // booking outcomes
  makeCounterProvider({
    name: METRICS.reservationsConfirmed,
    help: 'Reservations confirmed (successful POST /shows/:id/reserve)',
  }),
  makeCounterProvider({
    name: METRICS.holdsCreated,
    help: 'Seat holds created (successful POST /shows/:id/hold)',
  }),
  makeCounterProvider({
    name: METRICS.reservationsCancelled,
    help: 'Holds/reservations cancelled by their owner (POST /reservations/:id/cancel), by kind (hold, reserve)',
    labelNames: ['kind'],
  }),
  makeCounterProvider({
    name: METRICS.seatsReleased,
    help: 'Seats returned to available by owner cancellations',
  }),
  makeCounterProvider({
    name: METRICS.reservationsDeclined,
    help: 'Hold/reserve attempts that did not create anything, by reason (seat_taken, per_user_limit, idempotent_replay, idempotency_mismatch, request_in_progress, server_busy) and action (hold, reserve)',
    labelNames: ['reason', 'action'],
  }),

  // claim path / backpressure
  makeHistogramProvider({
    name: METRICS.claimSeatsDuration,
    help: 'Time spent in the single claim_seats() database call, by action and outcome',
    labelNames: ['action', 'outcome'],
    buckets: DURATION_BUCKETS,
  }),
  makeGaugeProvider({
    name: METRICS.claimQueueWaiting,
    help: 'Hold/reserve requests waiting for a database slot in the claim queue',
  }),
  makeHistogramProvider({
    name: METRICS.claimQueueWait,
    help: 'Time hold/reserve requests waited in the claim queue, in seconds',
    labelNames: ['action'],
    buckets: DURATION_BUCKETS,
  }),
  makeCounterProvider({
    name: METRICS.claimRetries,
    help: 'Hold/reserve/cancel requests whose database call hit a transient error (DB_UNAVAILABLE / SERVER_BUSY) and was retried, by action, the first error\'s reason, and outcome (recovered, exhausted)',
    labelNames: ['action', 'reason', 'outcome'],
  }),
  makeCounterProvider({
    name: METRICS.seatCacheRejections,
    help: 'Hot-seat losers answered 409 from the in-memory seat cache without touching the database, by stage (before_queue, after_wait, after_timeout)',
    labelNames: ['stage'],
  }),

  // errors
  makeCounterProvider({
    name: METRICS.dbErrors,
    help: 'Database/infrastructure errors turned into deliberate responses by the global filter, by reason and code (SQLSTATE, Node error code, or pool_timeout)',
    labelNames: ['reason', 'code'],
  }),
  makeCounterProvider({
    name: METRICS.unhandledErrors,
    help: 'Errors nothing could classify (answered 500); should stay 0',
  }),
];

@Global()
@Module({
  providers: [
    ...metricProviders,
    HttpMetrics,
    SeatStateMetrics,
    MetricsInitializer,
  ],
  exports: [...metricProviders, HttpMetrics],
})
export class MetricsModule {}
