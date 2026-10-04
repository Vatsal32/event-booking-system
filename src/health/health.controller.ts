import { Controller, Get, HttpCode, HttpStatus, HttpException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ShutdownService } from '../common/lifecycle/shutdown.service.js';
import { classifyDbError } from '../common/errors/db-error.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectPinoLogger(HealthController.name)
    private readonly logger: PinoLogger,
    private readonly dataSource: DataSource,
    private readonly shutdown: ShutdownService,
  ) {}

  /** When the database last answered the readiness query (ms since epoch). */
  private lastDbOkAt = 0;

  @Get('liveness')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 if the application process is alive. Does not check dependencies.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is alive',
    schema: {
      example: { status: 'ok', timestamp: '2024-01-15T10:30:00.000Z' },
    },
  })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readiness')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Returns 200 if the application should receive traffic. Fails closed with 503 if the database is unreachable or the app is shutting down. A database that is reachable but busy (pool saturated during a burst) still counts as ready, so the replica is not taken out of rotation mid-burst. A successful check is reused for 5s.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is ready (database reachable, or reachable but busy)',
    schema: {
      example: {
        status: 'ok',
        timestamp: '2024-01-15T10:30:00.000Z',
        dependencies: { database: 'reachable' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Application not ready - database unreachable, or shutting down',
    schema: {
      example: {
        statusCode: 503,
        message: 'Database unreachable',
        error: 'Service Unavailable',
        timestamp: '2024-01-15T10:30:00.000Z',
        dependencies: { database: 'unreachable' },
      },
    },
  })
  async readiness() {
    const timestamp = new Date().toISOString();

    if (this.shutdown.isShuttingDown) {
      throw notReady('Shutting down', timestamp, 'unknown');
    }

    // a recent success is good enough; don't add a query per probe during a burst
    if (Date.now() - this.lastDbOkAt < READY_CACHE_MS) {
      return ready(timestamp, 'reachable');
    }

    try {
      await withTimeout(this.dataSource.query('SELECT 1'), DB_CHECK_TIMEOUT_MS);
      this.lastDbOkAt = Date.now();
      return ready(timestamp, 'reachable');
    } catch (error) {
      // reachable but saturated (pool wait timeout, statement timeout, our own 2s cap):
      // stay in rotation, otherwise the platform would pull the replica mid-burst
      if (error instanceof CheckTimeoutError || classifyDbError(error) === 'SERVER_BUSY') {
        this.logger.warn({ err: error }, 'readiness: database busy');
        return ready(timestamp, 'busy');
      }
      this.logger.error({ err: error }, 'readiness: database unreachable');
      throw notReady('Database unreachable', timestamp, 'unreachable');
    }
  }
}

/** How long a successful database check is reused. */
const READY_CACHE_MS = 5_000;
/** Upper bound for the readiness query itself. */
const DB_CHECK_TIMEOUT_MS = 2_000;

class CheckTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CheckTimeoutError(`readiness check exceeded ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function ready(timestamp: string, database: 'reachable' | 'busy') {
  return { status: 'ok', timestamp, dependencies: { database } };
}

function notReady(
  message: string,
  timestamp: string,
  database: 'unreachable' | 'unknown',
): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message,
      error: 'Service Unavailable',
      timestamp,
      dependencies: { database },
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
