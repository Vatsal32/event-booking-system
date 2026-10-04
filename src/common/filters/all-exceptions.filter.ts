import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { METRICS } from '../../metrics/metric-names.js';
import { classifyDbError, errorCode } from '../errors/db-error.js';

/** Seconds a client should wait before retrying a 429. */
const RETRY_AFTER_SECONDS = '1';

interface ErrorResponse {
  statusCode: number;
  error: string;
  reason: string;
  message: string;
}

/**
 * Last line of defence for the "zero 5xx" requirement. HttpExceptions (every deliberate 4xx,
 * and readiness' 503) pass through unchanged. Anything else is classified:
 *   overloaded / database unavailable -> 429 + Retry-After (the client should retry),
 *   invalid data -> 400, unique violation -> 409, foreign key violation -> 400,
 *   unclassified -> 500, logged: those are genuine bugs.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    adapterHost: HttpAdapterHost,
    @InjectPinoLogger(AllExceptionsFilter.name)
    private readonly logger: PinoLogger,
    @InjectMetric(METRICS.dbErrors)
    private readonly dbErrors: Counter<string>,
    @InjectMetric(METRICS.unhandledErrors)
    private readonly unhandledErrors: Counter<string>,
  ) {
    super(adapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      // deliberate 429s (e.g. the claim queue timing out) get the same retry hint
      if (exception.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        this.setRetryAfter(host);
      }
      super.catch(exception, host);
      return;
    }

    const body = this.classify(exception);

    if (body.statusCode >= 500) {
      this.unhandledErrors.inc();
      this.logger.error({ err: exception }, 'unhandled error');
    } else {
      this.dbErrors.inc({ reason: body.reason, code: errorCode(exception) });
      if (body.statusCode === HttpStatus.TOO_MANY_REQUESTS) {
        this.logger.warn({ err: exception, reason: body.reason }, 'request shed');
        this.setRetryAfter(host);
      }
    }

    super.catch(new HttpException(body, body.statusCode), host);
  }

  private setRetryAfter(host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<{
      header: (name: string, value: string) => unknown;
    }>();
    reply.header('Retry-After', RETRY_AFTER_SECONDS);
  }

  private classify(exception: unknown): ErrorResponse {
    switch (classifyDbError(exception)) {
      case 'SERVER_BUSY':
        return tooManyRequests(
          'SERVER_BUSY',
          'The server is busy; retry shortly (with the same idempotency key)',
        );
      case 'DB_UNAVAILABLE':
        return tooManyRequests(
          'DB_UNAVAILABLE',
          'The database is temporarily unavailable; retry shortly (with the same idempotency key)',
        );
      case 'INVALID_INPUT':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          reason: 'INVALID_INPUT',
          message: 'Invalid input value',
        };
      case 'CONFLICT':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          reason: 'CONFLICT',
          message: 'Duplicate entry',
        };
      case 'INVALID_REFERENCE':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          reason: 'INVALID_REFERENCE',
          message: 'Referenced record does not exist',
        };
      default:
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Internal Server Error',
          reason: 'INTERNAL_ERROR',
          message: 'Internal server error',
        };
    }
  }
}

function tooManyRequests(reason: string, message: string): ErrorResponse {
  return {
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    error: 'Too Many Requests',
    reason,
    message,
  };
}
