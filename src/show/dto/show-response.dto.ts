import { ApiProperty } from '@nestjs/swagger';

/**
 * Seat status as the API reports it. HOLD -> 'held' only until held_until (then 'available');
 * RESERVED -> 'confirmed'.
 */
export type PublicSeatStatus = 'available' | 'held' | 'confirmed';

export class SeatCounts {
  @ApiProperty({ example: 98 })
  available: number;

  @ApiProperty({ example: 1 })
  held: number;

  @ApiProperty({ example: 1 })
  confirmed: number;
}

export class SeatResponseDto {
  @ApiProperty({
    description: 'Seat number',
    example: 'A1',
  })
  seat_number: string;

  @ApiProperty({
    description:
      'Current seat status: held = temporarily locked by a user until its hold expires; confirmed = reserved for good',
    example: 'available',
    enum: ['available', 'held', 'confirmed'],
  })
  status: PublicSeatStatus;
}

export class ShowResponseDto {
  @ApiProperty({
    description: 'Show ID',
    example: 1,
  })
  id: number;

  @ApiProperty({
    description: 'Same as id (kept for existing clients)',
    example: 1,
  })
  showId: number;

  @ApiProperty({
    description: 'Show name',
    example: 'friday-night',
  })
  name: string;

  @ApiProperty({
    description: 'All seats with their status',
    type: [SeatResponseDto],
  })
  seats: SeatResponseDto[];

  @ApiProperty({
    description: 'Seats per status; available + held + confirmed always equals total_seats',
    type: SeatCounts,
  })
  counts: SeatCounts;

  @ApiProperty({
    description: 'Total number of seats in the show',
    example: 100,
  })
  total_seats: number;

  @ApiProperty({
    description: 'Price per seat in paise',
    example: 25000,
  })
  price_paise: number;

  @ApiProperty({
    description:
      'Maximum seats a single user can hold or reserve for this show (held + reserved)',
    example: 4,
  })
  per_user_limit: number;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  created_at: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  updated_at: Date;
}