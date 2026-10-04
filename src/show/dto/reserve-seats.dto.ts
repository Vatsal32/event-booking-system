import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Length rule for an idempotency key, wherever it comes from (body field or header). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
// must match the reservations.idempotency_key column (varchar(100)); a longer key would fail in the DB
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/**
 * Body for POST /shows/:id/hold and POST /shows/:id/reserve.
 * The idempotency key may be sent as idempotency_key (the spec's name), idempotencyKey, or an
 * Idempotency-Key header; resolveIdempotencyKey() (src/show/idempotency-key.ts) picks exactly one.
 */
export class ReserveSeatsDto {
  @ApiProperty({
    description:
      'Seat numbers to hold or reserve (1-10 unique values, each at most 10 characters). All-or-nothing: either every seat is claimed or none is.',
    example: ['A1', 'A2'],
    type: [String],
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(10, { each: true })
  seats: string[];

  @ApiProperty({
    description:
      'Idempotency key for the request (preferred name). The same key always returns the original result. Alternatively send idempotencyKey or an Idempotency-Key header.',
    example: '3d341232a1148fe0787a90054717e0f5fffc09cdcb611b2069315ca606313fdd',
    required: false,
    minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
    maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(IDEMPOTENCY_KEY_MIN_LENGTH)
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotency_key?: string;

  @ApiProperty({
    description:
      'Same as idempotency_key (camelCase alias, kept for existing clients).',
    example: '3d341232a1148fe0787a90054717e0f5fffc09cdcb611b2069315ca606313fdd',
    required: false,
    minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
    maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(IDEMPOTENCY_KEY_MIN_LENGTH)
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;
}
