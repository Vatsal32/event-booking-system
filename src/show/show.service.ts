import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { Show } from './entities/show.entity.js';
import { Seat, SeatStatus } from './entities/seat.entity.js';
import { CreateShowDto } from './dto/create-show.dto.js';
import {
  PublicSeatStatus,
  SeatCounts,
  SeatResponseDto,
  ShowResponseDto,
} from './dto/show-response.dto.js';
import { InjectPinoLogger, Logger } from 'nestjs-pino';
import { AppConfigService } from '../config/config.service.js';
import {
  FifoSemaphore,
  SemaphoreTimeoutError,
} from '../common/concurrency/fifo-semaphore.js';
import { SeatCache } from './seat-cache.js';
import { METRICS } from '../metrics/metric-names.js';

/** A hold/reserve request after the controller has resolved the one idempotency key. */
export interface ClaimRequest {
  seats: string[];
  idempotencyKey: string;
}

/** 'HOLD' = POST /shows/:id/hold (lapses at held_until), 'RESERVE' = POST /shows/:id/reserve (permanent). */
export type ClaimMode = 'HOLD' | 'RESERVE';

/** Outcomes returned by the claim_seats() function (src/show/reserve-seats.sql.ts). */
type ClaimOutcome =
  | 'CREATED'
  | 'REPLAY'
  | 'IDEMPOTENCY_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'SEAT_TAKEN'
  | 'SEAT_NOT_FOUND'
  | 'SHOW_NOT_FOUND';

/** One row from claim_seats(); pg returns bigint as string. */
interface ClaimSeatsRow {
  outcome: ClaimOutcome;
  reservation_id: string | null;
  seat_numbers: string[] | null;
  amount_paise: string | null;
  expires_at: Date | null;
}

/** One row from cancel_reservation(); pg returns bigint as string. */
interface CancelReservationRow {
  outcome: 'CANCELLED' | 'ALREADY_CANCELLED' | 'NOT_FOUND';
  show_id: string | null;
  kind: string | null;
  released_seats: string[] | null;
}

export interface CancelResult {
  reservationId: string;
  showId: number;
  releasedSeats: string[];
}

export interface ReservationResult {
  reservationId: string;
  showId: number;
  userId: number;
  seats: string[];
  amountPaise: number;
  kind: ClaimMode;
  // when the hold lapses; null for a reservation, which is permanent
  heldUntil: Date | null;
  replay: boolean;
}

/** The `action` label on claim metrics: 'hold' or 'reserve'. */
function actionLabel(mode: ClaimMode): string {
  return mode === 'HOLD' ? 'hold' : 'reserve';
}

/** Unique index on reservations (user_id, idempotency_key); see reservation.entity.ts. */
const IDEMPOTENCY_CONSTRAINT = 'uq_reservations_user_idem';

/**
 * How long a hold/reserve request may wait for a turn at the database. Shorter than the pool's
 * connectionTimeoutMillis (5000), so the wait ends here first, where the seat cache can still
 * answer a loser with 409 instead of the pool timing out into a 429.
 */
const CLAIM_QUEUE_TIMEOUT_MS = 4000;

@Injectable()
export class ShowService {
  /**
   * Our own FIFO queue in front of the database, one slot per pooled connection. Unlike the
   * pool's internal queue, a request that gets its turn here runs our code again, so it can
   * re-check the seat cache and return 409 without using a connection. That lets a hot-seat
   * storm drain from memory once the winner is known.
   */
  private readonly claimGate: FifoSemaphore;

  constructor(
    @InjectPinoLogger(ShowService.name)
    private readonly logger: Logger,
    @InjectRepository(Show)
    private readonly showRepository: Repository<Show>,
    @InjectRepository(Seat)
    private readonly seatRepository: Repository<Seat>,
    private readonly dataSource: DataSource,
    private readonly appConfigService: AppConfigService,
    @InjectMetric(METRICS.reservationsConfirmed)
    private readonly confirmedCounter: Counter<string>,
    @InjectMetric(METRICS.reservationsDeclined)
    private readonly declinedCounter: Counter<string>,
    @InjectMetric(METRICS.holdsCreated)
    private readonly holdsCounter: Counter<string>,
    @InjectMetric(METRICS.claimSeatsDuration)
    private readonly claimSeatsDuration: Histogram<string>,
    @InjectMetric(METRICS.claimQueueWaiting)
    private readonly claimQueueWaiting: Gauge<string>,
    @InjectMetric(METRICS.claimQueueWait)
    private readonly claimQueueWait: Histogram<string>,
    @InjectMetric(METRICS.seatCacheRejections)
    private readonly seatCacheRejections: Counter<string>,
    @InjectMetric(METRICS.reservationsCancelled)
    private readonly cancelledCounter: Counter<string>,
    @InjectMetric(METRICS.seatsReleased)
    private readonly seatsReleasedCounter: Counter<string>,
    private readonly seatCache: SeatCache,
  ) {
    this.claimGate = new FifoSemaphore(
      Number(appConfigService.database.MAX_CONNECTIONS) || 10,
    );
  }

  async create(createShowDto: CreateShowDto): Promise<ShowResponseDto> {
    const { name, seats, price_paise, per_user_limit } = createShowDto;

    const uniqueSeats = new Set(seats);
    if (uniqueSeats.size !== seats.length) {
      throw new ConflictException('Duplicate seat numbers in request');
    }

    return this.dataSource.transaction(async (manager) => {
      const showRepo = manager.getRepository(Show);
      const seatRepo = manager.getRepository(Seat);

      const show = showRepo.create({
        name,
        pricePaise: price_paise,
        perUserLimit: per_user_limit,
      });

      try {
        // a bulk admin insert (up to MAX_SEATS_PER_SHOW seats) may take longer than the
        // request-path statement timeout; this applies to this transaction only
        await manager.query(`SET LOCAL statement_timeout = '30s'`);

        const savedShow = await showRepo.save(show);

        // every seat in one statement with two parameters, whatever the hall size (no per-entity
        // ORM work, no bind-parameter limit); status uses the column default, AVAILABLE
        const seatMeta = manager.connection.getMetadata(Seat);
        const column = (property: string) =>
          seatMeta.findColumnWithPropertyName(property)!.databaseName;
        await manager.query(
          `INSERT INTO "${seatMeta.tablePath}" ("${column('showId')}", "${column('seatNumber')}")
           SELECT $1, unnest($2::text[])`,
          [savedShow.showId, seats],
        );

        // the response is built from the input: every seat starts available
        const seatEntities = seats.map((seatNumber) =>
          seatRepo.create({
            seatNumber,
            status: SeatStatus.AVAILABLE,
            reservedBy: null,
            heldUntil: null,
          }),
        );

        return this.mapToResponseDto(savedShow, seatEntities);
      } catch (error) {
        if (error instanceof QueryFailedError) {
          const pgError = error.driverError as {
            code?: string;
            detail?: string;
            column?: string;
            constraint?: string;
          };
          switch (pgError?.code) {
            case '23505':
              if (
                pgError.detail?.includes('seat_number') ||
                pgError.column === 'seat_number' ||
                pgError.constraint?.includes('seat_number')
              ) {
                throw new ConflictException('Duplicate seat number');
              }
              throw new ConflictException('Duplicate entry');
            case '23503':
              throw new BadRequestException('Invalid show reference');
            case '22001':
              throw new BadRequestException(
                'Seat number too long (max 10 characters)',
              );
            case '22003':
              throw new BadRequestException('Price value too large');
            case '22P02':
              if (
                pgError.detail?.includes('price_paise') ||
                pgError.column === 'price_paise'
              ) {
                throw new BadRequestException(
                  'Price must be an integer (paise)',
                );
              }
              if (
                pgError.detail?.includes('status') ||
                pgError.column === 'status' ||
                pgError.constraint?.includes('status')
              ) {
                throw new BadRequestException('Invalid seat status value');
              }
              throw new BadRequestException('Invalid input value');
          }
        }
        // anything else (pool timeout, DB down, ...) is classified by AllExceptionsFilter
        throw error;
      }
    });
  }

  async findOne(id: number): Promise<ShowResponseDto> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('Invalid show ID');
    }

    try {
      const show = await this.showRepository.findOne({
        where: { showId: id },
        relations: { seats: true },
      });

      if (!show) {
        throw new NotFoundException(`Show with ID ${id} not found`);
      }

      // a full read of the seats is also a fresh view for the hot-seat cache
      this.seatCache.replaceShow(id, show.seats);

      return this.mapToResponseDto(show, show.seats);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      if (error instanceof QueryFailedError) {
        const pgError = error.driverError as { code?: string };
        if (pgError?.code === '22P02') {
          throw new BadRequestException('Invalid show ID format');
        }
      }
      // anything else (pool timeout, DB down, ...) is classified by AllExceptionsFilter
      throw error;
    }
  }

  /**
   * The owner cancels one of their holds or reservations: its seats go back to available. Seats
   * someone else has taken since are never touched. Cancelling twice releases nothing the second
   * time. Someone else's reservation id is reported exactly like a missing one (404).
   */
  async cancel(reservationId: number, userId: number): Promise<CancelResult> {
    if (!Number.isInteger(reservationId) || reservationId <= 0) {
      throw new BadRequestException('Invalid reservation ID');
    }

    let row: CancelReservationRow;
    try {
      const rows: CancelReservationRow[] = await this.dataSource.query(
        'SELECT * FROM cancel_reservation($1, $2)',
        [reservationId, userId],
      );
      row = rows[0];
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === '55P03'
      ) {
        throw this.conflict(
          'REQUEST_IN_PROGRESS',
          'Another request from this user for this show is in progress; retry shortly',
        );
      }
      throw error; // pool timeout, DB down, ... -> AllExceptionsFilter
    }

    if (row.outcome === 'NOT_FOUND') {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }

    const showId = Number(row.show_id);
    const releasedSeats = row.released_seats ?? [];
    if (row.outcome === 'CANCELLED') {
      this.seatCache.release(showId, releasedSeats);
      this.cancelledCounter.inc({ kind: row.kind === 'HOLD' ? 'hold' : 'reserve' });
      this.seatsReleasedCounter.inc(releasedSeats.length);
    }
    return { reservationId: String(reservationId), showId, releasedSeats };
  }

  /** Temporarily locks free seats for the user (AVAILABLE -> HOLD); the hold lapses at held_until. */
  async hold(
    showId: number,
    request: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    return this.claimSeats('HOLD', showId, request, userId);
  }

  /**
   * Permanently reserves seats (-> RESERVED). Accepts seats that are free or that the user
   * currently holds, so "hold then reserve" and "reserve directly" both work.
   */
  async reserve(
    showId: number,
    request: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    return this.claimSeats('RESERVE', showId, request, userId);
  }

  /**
   * Holds or reserves seats with a single call to claim_seats(): one pooled connection, one
   * round trip. The function does the per-user lock, idempotency check, per-user limit, seat
   * locking and writes atomically; this method only validates, calls it, and maps the outcome.
   */
  private async claimSeats(
    mode: ClaimMode,
    showId: number,
    { seats, idempotencyKey }: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    if (!Number.isInteger(showId) || showId <= 0) {
      throw new BadRequestException('Invalid show ID');
    }

    // same endpoint + show + seats (in any order) => same hash; a key must always carry the same
    // request, so reusing a hold's key on /reserve is rejected as a mismatch
    const requestHash = createHash('sha256')
      .update(`${mode}:${showId}:${[...seats].sort().join(',')}`)
      .digest('hex');
    const ttlSeconds = Math.round(
      Number(this.appConfigService.lockDurationMin) * 60,
    );
    const params = [
      mode,
      showId,
      userId,
      seats,
      idempotencyKey,
      requestHash,
      ttlSeconds,
    ];

    const action = actionLabel(mode);

    // Hot-seat losers are answered from memory once a winner is known: no slot, no database.
    this.rejectIfTakenByOther(showId, seats, userId, action, 'before_queue');

    let release: () => void;
    const waitStartedAt = performance.now();
    this.claimQueueWaiting.inc();
    try {
      release = await this.claimGate.acquire(CLAIM_QUEUE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof SemaphoreTimeoutError)) throw error;
      // Waited too long. If a winner was recorded meanwhile this is still a clean 409;
      // otherwise the seats may really be free and the database is the bottleneck.
      this.rejectIfTakenByOther(showId, seats, userId, action, 'after_timeout');
      this.declinedCounter.inc({ reason: 'server_busy', action });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          reason: 'SERVER_BUSY',
          message:
            'The server is busy; retry shortly (with the same idempotency key)',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } finally {
      this.claimQueueWaiting.dec();
      this.claimQueueWait.observe(
        { action },
        (performance.now() - waitStartedAt) / 1000,
      );
    }

    let row: ClaimSeatsRow;
    try {
      // a winner may have been recorded while this request was waiting for its turn
      this.rejectIfTakenByOther(showId, seats, userId, action, 'after_wait');

      try {
        row = await this.callClaimSeats(params, action);
      } catch (error) {
        if (!this.isIdempotencyRace(error)) {
          throw this.toHttpError(error, action);
        }
        // The same key was used for another request at the same moment and that request
        // committed first. Calling again now returns REPLAY or IDEMPOTENCY_MISMATCH.
        try {
          row = await this.callClaimSeats(params, action);
        } catch (retryError) {
          throw this.toHttpError(retryError, action);
        }
      }
    } finally {
      release();
    }

    const result = this.toReservationResult(row, mode, showId, userId);
    if (!result.replay) {
      // a replay's stored result may be out of date, so only fresh claims are recorded
      this.seatCache.record(
        showId,
        result.seats,
        userId,
        mode === 'HOLD' && result.heldUntil ? result.heldUntil.getTime() : null,
      );
    }
    return result;
  }

  /** 409 SEAT_TAKEN straight from memory when another user is known to hold or own a seat. */
  private rejectIfTakenByOther(
    showId: number,
    seats: string[],
    userId: number,
    action: string,
    stage: 'before_queue' | 'after_wait' | 'after_timeout',
  ): void {
    if (this.seatCache.takenByOther(showId, seats, userId)) {
      this.seatCacheRejections.inc({ stage });
      this.declinedCounter.inc({ reason: 'seat_taken', action });
      throw this.conflict(
        'SEAT_TAKEN',
        'One or more of the requested seats are already taken',
      );
    }
  }

  private async callClaimSeats(
    params: unknown[],
    action: string,
  ): Promise<ClaimSeatsRow> {
    const endTimer = this.claimSeatsDuration.startTimer({ action });
    try {
      const rows: ClaimSeatsRow[] = await this.dataSource.query(
        'SELECT * FROM claim_seats($1, $2, $3, $4, $5, $6, $7)',
        params,
      );
      endTimer({ outcome: rows[0]?.outcome ?? 'error' });
      return rows[0];
    } catch (error) {
      endTimer({ outcome: 'error' });
      throw error;
    }
  }

  private toReservationResult(
    row: ClaimSeatsRow,
    mode: ClaimMode,
    showId: number,
    userId: number,
  ): ReservationResult {
    const action = actionLabel(mode);
    switch (row.outcome) {
      case 'CREATED':
      case 'REPLAY': {
        const replay = row.outcome === 'REPLAY';
        if (replay) {
          this.declinedCounter.inc({ reason: 'idempotent_replay', action });
        } else if (mode === 'HOLD') {
          this.holdsCounter.inc();
        } else {
          this.confirmedCounter.inc();
        }
        return {
          reservationId: String(row.reservation_id),
          showId,
          userId,
          seats: row.seat_numbers ?? [],
          amountPaise: Number(row.amount_paise),
          kind: mode,
          heldUntil: row.expires_at,
          replay,
        };
      }
      case 'SEAT_TAKEN':
        this.declinedCounter.inc({ reason: 'seat_taken', action });
        throw this.conflict(
          'SEAT_TAKEN',
          'One or more of the requested seats are already taken',
        );
      case 'LIMIT_EXCEEDED':
        this.declinedCounter.inc({ reason: 'per_user_limit', action });
        throw this.conflict(
          'PER_USER_LIMIT',
          'This reservation would exceed the per-user seat limit for the show',
        );
      case 'IDEMPOTENCY_MISMATCH':
        this.declinedCounter.inc({ reason: 'idempotency_mismatch', action });
        throw this.conflict(
          'IDEMPOTENCY_KEY_MISMATCH',
          'This idempotency key was already used with a different request body',
        );
      case 'SHOW_NOT_FOUND':
        throw new NotFoundException(`Show with ID ${showId} not found`);
      case 'SEAT_NOT_FOUND':
        throw new NotFoundException(
          'One or more of the requested seats do not exist for this show',
        );
      default:
        this.logger.error({ row }, 'claim_seats() returned an unknown outcome');
        throw new InternalServerErrorException('Failed to reserve seats');
    }
  }

  /** 23505 on the (user_id, idempotency_key) unique index. */
  private isIdempotencyRace(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const pgError = error.driverError as { code?: string; constraint?: string };
    return (
      pgError?.code === '23505' && pgError.constraint === IDEMPOTENCY_CONSTRAINT
    );
  }

  /** Maps errors from the claim_seats() call to a deliberate HTTP response. */
  private toHttpError(error: unknown, action: string): Error {
    if (error instanceof HttpException) {
      return error;
    }

    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as { code?: string; message?: string };
      if (pgError?.code === '55P03') {
        // NOWAIT on the seat gate: another in-flight request has one of these seats locked
        if (pgError.message?.includes('could not obtain lock on row')) {
          this.declinedCounter.inc({ reason: 'seat_taken', action });
          return this.conflict(
            'SEAT_TAKEN',
            'One or more of the requested seats are already taken',
          );
        }
        // lock_timeout on the per-(show, user) advisory lock
        this.declinedCounter.inc({ reason: 'request_in_progress', action });
        return this.conflict(
          'REQUEST_IN_PROGRESS',
          'Another reservation from this user for this show is in progress; retry with the same idempotency key',
        );
      }
      if (pgError?.code?.startsWith('22')) {
        return new BadRequestException('Invalid reservation request');
      }
      // seats.reserved_by -> users: the token is trusted without a lookup, so its user may not exist
      if (pgError?.code === '23503') {
        return new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          error: 'Unauthorized',
          reason: 'UNKNOWN_USER',
          message: "The token's user does not exist",
        });
      }
    }

    // Infrastructure errors (pool timeout, DB down, ...) go to AllExceptionsFilter, which answers
    // 429 + Retry-After; anything it can't classify is logged there as a 500.
    return error as Error;
  }

  private conflict(reason: string, message: string): ConflictException {
    return new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      reason,
      message,
    });
  }

  private mapToResponseDto(show: Show, seats: Seat[]): ShowResponseDto {
    // one clock for the whole response, so every seat is judged at the same instant
    const now = Date.now();
    const counts: SeatCounts = { available: 0, held: 0, confirmed: 0 };

    const seatResponses: SeatResponseDto[] = seats.map((seat) => {
      const status = this.publicSeatStatus(seat, now);
      counts[status]++;
      return { seat_number: seat.seatNumber, status };
    });

    return {
      id: show.showId,
      showId: show.showId,
      name: show.name,
      seats: seatResponses,
      counts,
      // available + held + confirmed == total_seats by construction: every seat maps to exactly one
      total_seats: seats.length,
      price_paise: Number(show.pricePaise),
      per_user_limit: show.perUserLimit,
      created_at: show.createdAt,
      updated_at: show.updatedAt,
    };
  }

  /** HOLD only counts as held until held_until; after that the seat is free again. RESERVED never lapses. */
  private publicSeatStatus(seat: Seat, now: number): PublicSeatStatus {
    switch (seat.status) {
      case SeatStatus.RESERVED:
        return 'confirmed';
      case SeatStatus.HOLD:
        return seat.heldUntil && seat.heldUntil.getTime() > now
          ? 'held'
          : 'available';
      default:
        return 'available';
    }
  }
}
