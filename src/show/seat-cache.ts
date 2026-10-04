import { Injectable } from '@nestjs/common';
import { Seat, SeatStatus } from './entities/seat.entity.js';

interface TakenSeat {
  ownerId: number;
  // held_until in ms for a HOLD; null for RESERVED, which only ends if its owner cancels
  until: number | null;
}

/**
 * Per-instance memory of seats known to be taken, so hot-seat losers get their 409 without
 * touching the database (or waiting for a pool connection and timing out into a 429).
 *
 * A cached "taken by someone else" is never wrong on the instance that holds it: while a seat
 * stays taken its owner never changes (HOLD -> RESERVED keeps the owner), a hold ends at
 * held_until (stored here), and the only other way a seat is freed is its owner cancelling,
 * which this instance applies via release(). An outdated entry that says "free" just sends the
 * request to the database, which still decides. With several replicas, another replica could
 * keep a cancelled seat as "taken" until its next GET /shows/:id refresh; the service runs as a
 * single replica.
 */
@Injectable()
export class SeatCache {
  private readonly shows = new Map<number, Map<string, TakenSeat>>();

  /** True if any of the seats is held or reserved by a user other than `userId`. */
  takenByOther(
    showId: number,
    seats: string[],
    userId: number,
    now = Date.now(),
  ): boolean {
    const taken = this.shows.get(showId);
    if (!taken) return false;

    for (const seat of seats) {
      const entry = taken.get(seat);
      if (!entry) continue;
      if (entry.until !== null && entry.until <= now) {
        taken.delete(seat); // the hold has lapsed
        continue;
      }
      // seats the caller owns never block: replays and hold-then-reserve go to the database
      if (entry.ownerId !== userId) return true;
    }
    return false;
  }

  /** Remembers seats just claimed by `ownerId` (until = held_until for a hold, null if reserved). */
  record(
    showId: number,
    seats: string[],
    ownerId: number,
    until: number | null,
  ): void {
    let taken = this.shows.get(showId);
    if (!taken) {
      taken = new Map();
      this.shows.set(showId, taken);
    }
    for (const seat of seats) taken.set(seat, { ownerId, until });
  }

  /** Forgets seats the owner just released (POST /reservations/:id/cancel). */
  release(showId: number, seats: string[]): void {
    const taken = this.shows.get(showId);
    if (!taken) return;
    for (const seat of seats) taken.delete(seat);
  }

  /** Rebuilds a show's entries from a full read of its seats (GET /shows/:id). */
  replaceShow(showId: number, seats: Seat[], now = Date.now()): void {
    const taken = new Map<string, TakenSeat>();
    for (const seat of seats) {
      if (seat.reservedBy === null) continue;
      const ownerId = Number(seat.reservedBy);
      if (seat.status === SeatStatus.RESERVED) {
        taken.set(seat.seatNumber, { ownerId, until: null });
      } else if (
        seat.status === SeatStatus.HOLD &&
        seat.heldUntil &&
        seat.heldUntil.getTime() > now
      ) {
        taken.set(seat.seatNumber, {
          ownerId,
          until: seat.heldUntil.getTime(),
        });
      }
    }
    this.shows.set(showId, taken);
  }
}
