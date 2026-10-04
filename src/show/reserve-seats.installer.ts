import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  CANCEL_RESERVATION_FUNCTION_SQL,
  CLAIM_SEATS_FUNCTION_SQL,
} from './reserve-seats.sql.js';

/**
 * Creates (or replaces) the claim_seats() and cancel_reservation() functions at startup, and
 * drops the old reserve_seats(). TypeORM's synchronize only manages tables, and it runs during module init,
 * so the tables exist by the time this runs. If this fails the app fails to start, which is
 * what we want: holds and reservations can't work without it.
 */
@Injectable()
export class ReserveSeatsInstaller implements OnApplicationBootstrap {
  constructor(
    @InjectPinoLogger(ReserveSeatsInstaller.name)
    private readonly logger: PinoLogger,
    private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.dataSource.query(CLAIM_SEATS_FUNCTION_SQL);
    await this.dataSource.query(CANCEL_RESERVATION_FUNCTION_SQL);
    this.logger.info('claim_seats() and cancel_reservation() functions installed');
  }
}
