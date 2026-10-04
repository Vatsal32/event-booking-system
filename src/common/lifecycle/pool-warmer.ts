import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../config/config.service.js';

/** The parts of the pg pool (TypeORM exposes it as driver.master) used here. */
interface PgPool {
  connect(): Promise<{ query(sql: string): Promise<unknown>; release(): void }>;
}

/**
 * Opens every pooled database connection before the app starts serving (onApplicationBootstrap
 * runs before app.listen), so the first burst reuses ready connections (TCP + TLS + auth already
 * done) instead of opening them under load over a long-distance link. Together with the pool's
 * long idleTimeoutMillis and TCP keepalive (app.module.ts), the pool stays warm between bursts.
 * Connections lost later (e.g. the database compute suspending) are simply reopened on demand.
 * Never blocks startup: failures are logged.
 */
@Injectable()
export class PoolWarmer implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: AppConfigService,
    @InjectPinoLogger(PoolWarmer.name)
    private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pool = (this.dataSource.driver as unknown as { master?: PgPool }).master;
    if (!pool) return;
    const size = Number(this.config.database.MAX_CONNECTIONS) || 10;
    const startedAt = Date.now();

    // check out `size` clients at the same time, so the pool must open `size` separate
    // connections (connecting and releasing one at a time would just reuse one)
    const results = await Promise.allSettled(
      Array.from({ length: size }, () => pool.connect()),
    );
    const clients = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    await Promise.allSettled(clients.map((c) => c.query('SELECT 1')));
    clients.forEach((c) => c.release());

    const details = {
      opened: clients.length,
      wanted: size,
      ms: Date.now() - startedAt,
    };
    if (clients.length < size) {
      const firstError = results.find((r) => r.status === 'rejected');
      this.logger.warn(
        { ...details, err: firstError?.status === 'rejected' ? firstError.reason : undefined },
        'database pool only partly warmed',
      );
    } else {
      this.logger.info(details, 'database pool warmed');
    }
  }
}
