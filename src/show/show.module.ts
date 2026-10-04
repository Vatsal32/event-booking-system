import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Show } from './entities/show.entity.js';
import { Seat } from './entities/seat.entity.js';
import { ShowService } from './show.service.js';
import { ShowController } from './show.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { Reservation } from './entities/reservation.entity.js';
import { ReserveSeatsInstaller } from './reserve-seats.installer.js';
import { SeatCache } from './seat-cache.js';
import { ReservationController } from './reservation.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Show, Seat, Reservation]),
    AuthModule,
  ],
  controllers: [ShowController, ReservationController],
  providers: [
    ShowService,
    ReserveSeatsInstaller,
    SeatCache,
    // metrics come from the global MetricsModule (src/metrics/metrics.module.ts)
  ],
  exports: [ShowService],
})
export class ShowModule {}
