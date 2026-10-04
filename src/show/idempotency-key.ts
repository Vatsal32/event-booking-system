import { BadRequestException } from '@nestjs/common';
import { length } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  ReserveSeatsDto,
} from './dto/reserve-seats.dto.js';

/**
 * Picks the one idempotency key for a hold/reserve request. It may arrive as the
 * idempotency_key body field (the spec's name), the idempotencyKey body field, or an
 * Idempotency-Key header. The body fields are already validated by the DTO; the header gets
 * the same length rule here. Sending the same key in several places is fine; two different
 * keys, or none at all, is a 400.
 */
export function resolveIdempotencyKey(
  body: ReserveSeatsDto,
  header: string | string[] | undefined,
): string {
  if (Array.isArray(header)) {
    throw new BadRequestException('Send a single Idempotency-Key header');
  }

  const headerKey = header?.trim();
  if (
    headerKey !== undefined &&
    headerKey !== '' &&
    !length(headerKey, IDEMPOTENCY_KEY_MIN_LENGTH, IDEMPOTENCY_KEY_MAX_LENGTH)
  ) {
    throw new BadRequestException(
      `Idempotency-Key header must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }

  const keys = new Set(
    [body.idempotency_key, body.idempotencyKey, headerKey].filter(
      (key): key is string => key !== undefined && key !== '',
    ),
  );

  if (keys.size === 0) {
    throw new BadRequestException(
      'An idempotency key is required: send idempotency_key in the body or an Idempotency-Key header',
    );
  }
  if (keys.size > 1) {
    throw new BadRequestException(
      'Conflicting idempotency keys in body and header',
    );
  }

  return [...keys][0];
}
