import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Validate,
} from 'class-validator';
import { IsPositiveIntegerConstraint } from '../../common/validators/is-positive-integer.validator.js';

/**
 * Most seats a single show can have. GET /shows/:id returns every seat, so this keeps that
 * response around 2 MB; it also bounds what a leaked admin key could write in one request.
 */
export const MAX_SEATS_PER_SHOW = 50_100;

export class CreateShowDto {
  @ApiProperty({
    description:
      'Name of the show (does not need to be unique; shows are identified by their id)',
    example: 'friday-night',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: `Seat numbers for the show (e.g., ["A1", "A2", "A3"]): 1 to ${MAX_SEATS_PER_SHOW.toLocaleString('en-US')} seats per show, each a non-empty string of at most 10 characters; duplicates are rejected with 409.`,
    example: ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5'],
    type: [String],
    minItems: 1,
    maxItems: MAX_SEATS_PER_SHOW,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SEATS_PER_SHOW)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(10, { each: true })
  seats: string[];

  @ApiProperty({
    description: 'Price per seat in paise (integer, e.g., 25000 = ₹250.00)',
    example: 25000,
    minimum: 1,
  })
  @Validate(IsPositiveIntegerConstraint)
  price_paise: number;

  @ApiProperty({
    description:
      'Maximum seats a single user can hold or reserve for this show (default 4, as in the spec)',
    example: 4,
    minimum: 1,
    maximum: 50,
    default: 4,
    required: false,
  })
  @Validate(IsPositiveIntegerConstraint)
  @Max(50)
  per_user_limit: number = 4;
}
