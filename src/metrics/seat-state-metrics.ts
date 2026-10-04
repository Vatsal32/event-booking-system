import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Gauge, register } from 'prom-client';
import { DataSource } from 'typeorm';
import { METRICS } from './metric-names.js';

/** How long one seat-state query result is reused, so frequent scrapes don't hammer the DB. */
const SNAPSHOT_TTL_MS = 1000;
/** Only the newest shows get seat gauges, to keep the number of label values bounded. */
const MAX_SHOWS = 50;

/**
 * Same rule as GET /shows/:id (ShowService.publicSeatStatus): an expired HOLD counts as
 * available, so these gauges reconcile with the API.
 */
const SEAT_STATE_SQL = `
  SELECT s.show_id::text AS show_id,
         count(*)::int AS total,
         count(*) FILTER (WHERE s.status = 'AVAILABLE'
                             OR (s.status = 'HOLD' AND s.held_until <= now()))::int AS available,
         count(*) FILTER (WHERE s.status = 'HOLD' AND s.held_until > now())::int    AS held,
         count(*) FILTER (WHERE s.status = 'RESERVED')::int                         AS confirmed
    FROM seats s
   WHERE s.show_id IN (SELECT show_id FROM shows ORDER BY show_id DESC LIMIT ${MAX_SHOWS})
   GROUP BY s.show_id`;

interface SeatStateRow {
  show_id: string;
  total: number;
  available: number;
  held: number;
  confirmed: number;
}

/** The pg pool counters this reads (TypeORM exposes the pool as driver.master). */
interface PgPool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/**
 * Gauges computed when Prometheus scrapes /metrics: per-show seat counts (one DB query per
 * scrape, cached for 1s), db_up from whether that query worked, and pg pool usage. A failed
 * query never fails the scrape: db_up drops to 0 and the last seat values are kept.
 */
@Injectable()
export class SeatStateMetrics {
  private snapshot: Promise<void> | null = null;
  private snapshotAt = 0;

  private readonly available: Gauge<string>;
  private readonly held: Gauge<string>;
  private readonly confirmed: Gauge<string>;
  private readonly total: Gauge<string>;
  private readonly dbUp: Gauge<string>;

  constructor(
    private readonly dataSource: DataSource,
    @InjectPinoLogger(SeatStateMetrics.name)
    private readonly logger: PinoLogger,
  ) {
    // every seat gauge awaits the same snapshot, so one scrape shows one consistent picture
    const refresh = () => this.refreshSnapshot();
    const seatGauge = (name: string, help: string) =>
      new Gauge({
        name,
        help,
        labelNames: ['show_id'],
        registers: [register],
        collect: refresh,
      });

    this.available = seatGauge(
      METRICS.seatsAvailable,
      'Seats currently available per show (an expired hold counts as available)',
    );
    this.held = seatGauge(METRICS.seatsHeld, 'Seats currently held (unexpired) per show');
    this.confirmed = seatGauge(
      METRICS.seatsConfirmed,
      'Seats reserved for good per show',
    );
    this.total = seatGauge(
      METRICS.seatsTotal,
      'Total seats per show; available + held + confirmed always equals this',
    );
    this.dbUp = new Gauge({
      name: METRICS.dbUp,
      help: '1 if the database answered the last scrape-time query, else 0',
      registers: [register],
      collect: refresh,
    });

    const pool = () => this.pool();
    new Gauge({
      name: METRICS.dbPoolConnections,
      help: 'pg pool connections: total open, idle, and requests waiting for one',
      labelNames: ['state'],
      registers: [register],
      collect() {
        const p = pool();
        if (!p) return;
        this.set({ state: 'total' }, p.totalCount);
        this.set({ state: 'idle' }, p.idleCount);
        this.set({ state: 'waiting' }, p.waitingCount);
      },
    });
  }

  private refreshSnapshot(): Promise<void> {
    if (!this.snapshot || Date.now() - this.snapshotAt > SNAPSHOT_TTL_MS) {
      this.snapshotAt = Date.now();
      this.snapshot = this.loadSnapshot();
    }
    return this.snapshot;
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const rows: SeatStateRow[] = await this.dataSource.query(SEAT_STATE_SQL);
      for (const gauge of [this.available, this.held, this.confirmed, this.total]) {
        gauge.reset(); // shows that no longer exist (or fell out of the newest 50) disappear
      }
      for (const row of rows) {
        const labels = { show_id: row.show_id };
        this.available.set(labels, row.available);
        this.held.set(labels, row.held);
        this.confirmed.set(labels, row.confirmed);
        this.total.set(labels, row.total);
      }
      this.dbUp.set(1);
    } catch (error) {
      this.dbUp.set(0);
      this.logger.warn({ err: error }, 'seat-state metrics query failed');
    }
  }

  private pool(): PgPool | undefined {
    const driver = this.dataSource.driver as unknown as { master?: PgPool };
    return driver.master;
  }
}
