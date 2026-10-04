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
import { classifyDbError, getPgCode } from '../common/errors/db-error.js';
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
  heldUntil: Date | null;
  replay: boolean;
}

function actionLabel(mode: ClaimMode): string {
  return mode === 'HOLD' ? 'hold' : 'reserve';
}

const IDEMPOTENCY_CONSTRAINT = 'uq_reservations_user_idem';

const CLAIM_QUEUE_TIMEOUT_MS = 4000;

const TRANSIENT_RETRY_BACKOFF_MS: [number, number][] = [
  [50, 150],
  [200, 400],
];
const TRANSIENT_RETRY_BUDGET_MS = 3000;

@Injectable()
export class ShowService {
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
    @InjectMetric(METRICS.claimRetries)
    private readonly claimRetries: Counter<string>,
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
        await manager.query(`SET LOCAL statement_timeout = '30s'`);

        const savedShow = await showRepo.save(show);

        const seatMeta = manager.connection.getMetadata(Seat);
        const column = (property: string) =>
          seatMeta.findColumnWithPropertyName(property)!.databaseName;
        await manager.query(
          `INSERT INTO "${seatMeta.tablePath}" ("${column('showId')}", "${column('seatNumber')}")
           SELECT $1, unnest($2::text[])`,
          [savedShow.showId, seats],
        );

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
      const rows: CancelReservationRow[] = await this.withTransientRetry(
        'cancel',
        () =>
          this.dataSource.query('SELECT * FROM cancel_reservation($1, $2)', [
            reservationId,
            userId,
          ]),
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
      this.cancelledCounter.inc({
        kind: row.kind === 'HOLD' ? 'hold' : 'reserve',
      });
      this.seatsReleasedCounter.inc(releasedSeats.length);
    }
    return { reservationId: String(reservationId), showId, releasedSeats };
  }

  async hold(
    showId: number,
    request: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    return this.claimSeats('HOLD', showId, request, userId);
  }

  async reserve(
    showId: number,
    request: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    return this.claimSeats('RESERVE', showId, request, userId);
  }

  private async claimSeats(
    mode: ClaimMode,
    showId: number,
    { seats, idempotencyKey }: ClaimRequest,
    userId: number,
  ): Promise<ReservationResult> {
    if (!Number.isInteger(showId) || showId <= 0) {
      throw new BadRequestException('Invalid show ID');
    }

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

    this.rejectIfTakenByOther(showId, seats, userId, action, 'before_queue');

    let release: () => void;
    const waitStartedAt = performance.now();
    this.claimQueueWaiting.inc();
    try {
      release = await this.claimGate.acquire(CLAIM_QUEUE_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof SemaphoreTimeoutError)) throw error;
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
      this.rejectIfTakenByOther(showId, seats, userId, action, 'after_wait');

      const claim = () =>
        this.withTransientRetry(action, () =>
          this.callClaimSeats(params, action),
        );
      try {
        row = await claim();
      } catch (error) {
        if (!this.isIdempotencyRace(error)) {
          throw this.toHttpError(error, action);
        }
        try {
          row = await claim();
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

  private async withTransientRetry<T>(
    action: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    let firstReason: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await call();
        if (firstReason) {
          this.claimRetries.inc({
            action,
            reason: firstReason,
            outcome: 'recovered',
          });
        }
        return result;
      } catch (error) {
        const kind = classifyDbError(error);
        const transient =
          kind === 'DB_UNAVAILABLE' ||
          (kind === 'SERVER_BUSY' && getPgCode(error) !== '55P03');
        const backoff = TRANSIENT_RETRY_BACKOFF_MS[attempt];
        const elapsed = Date.now() - startedAt;
        if (!transient || backoff === undefined) {
          if (firstReason) {
            this.claimRetries.inc({
              action,
              reason: firstReason,
              outcome: 'exhausted',
            });
          }
          throw error;
        }
        const delay = backoff[0] + Math.random() * (backoff[1] - backoff[0]);
        if (elapsed + delay > TRANSIENT_RETRY_BUDGET_MS) {
          if (firstReason) {
            this.claimRetries.inc({
              action,
              reason: firstReason,
              outcome: 'exhausted',
            });
          }
          throw error;
        }
        firstReason ??= kind;
        this.logger.warn(
          { err: error, action, attempt: attempt + 1, reason: kind },
          'transient database error, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

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

  private isIdempotencyRace(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const pgError = error.driverError as { code?: string; constraint?: string };
    return (
      pgError?.code === '23505' && pgError.constraint === IDEMPOTENCY_CONSTRAINT
    );
  }

  private toHttpError(error: unknown, action: string): Error {
    if (error instanceof HttpException) {
      return error;
    }

    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as { code?: string; message?: string };
      if (pgError?.code === '55P03') {
        if (pgError.message?.includes('could not obtain lock on row')) {
          this.declinedCounter.inc({ reason: 'seat_taken', action });
          return this.conflict(
            'SEAT_TAKEN',
            'One or more of the requested seats are already taken',
          );
        }
        this.declinedCounter.inc({ reason: 'request_in_progress', action });
        return this.conflict(
          'REQUEST_IN_PROGRESS',
          'Another reservation from this user for this show is in progress; retry with the same idempotency key',
        );
      }
      if (pgError?.code?.startsWith('22')) {
        return new BadRequestException('Invalid reservation request');
      }
      if (pgError?.code === '23503') {
        return new UnauthorizedException({
          statusCode: HttpStatus.UNAUTHORIZED,
          error: 'Unauthorized',
          reason: 'UNKNOWN_USER',
          message: "The token's user does not exist",
        });
      }
    }

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
      total_seats: seats.length,
      price_paise: Number(show.pricePaise),
      per_user_limit: show.perUserLimit,
      created_at: show.createdAt,
      updated_at: show.updatedAt,
    };
  }

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
