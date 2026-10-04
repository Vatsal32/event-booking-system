/** Names of every custom Prometheus metric, so providers and @InjectMetric() can't drift apart. */
export const METRICS = {
  // HTTP, every route (src/metrics/http-metrics.ts)
  httpRequestsTotal: 'http_requests_total',
  httpRequestDuration: 'http_request_duration_seconds',
  httpRequestsInFlight: 'http_requests_in_flight',

  // booking outcomes (src/show/show.service.ts)
  reservationsConfirmed: 'reservations_confirmed_total',
  holdsCreated: 'holds_created_total',
  reservationsCancelled: 'reservations_cancelled_total',
  seatsReleased: 'seats_released_total',
  reservationsDeclined: 'reservations_declined_total',

  // claim path / backpressure (src/show/show.service.ts)
  claimSeatsDuration: 'claim_seats_duration_seconds',
  claimQueueWaiting: 'claim_queue_waiting',
  claimQueueWait: 'claim_queue_wait_seconds',
  seatCacheRejections: 'seat_cache_rejections_total',
  claimRetries: 'claim_retries_total',

  // errors (src/common/filters/all-exceptions.filter.ts)
  dbErrors: 'db_errors_total',
  unhandledErrors: 'unhandled_errors_total',

  // seat state and DB health, computed on scrape (src/metrics/seat-state-metrics.ts)
  seatsAvailable: 'seats_available',
  seatsHeld: 'seats_held',
  seatsConfirmed: 'seats_confirmed',
  seatsTotal: 'seats_total',
  dbUp: 'db_up',
  dbPoolConnections: 'db_pool_connections',
} as const;

/** Latency buckets in seconds: 5ms .. 30s. */
export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];
