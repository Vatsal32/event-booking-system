import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseIntPipe,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { ShowService } from './show.service.js';
import { CreateShowDto } from './dto/create-show.dto.js';
import { ShowResponseDto } from './dto/show-response.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { ReserveSeatsDto } from './dto/reserve-seats.dto.js';
import { GetUser } from '../auth/get-user.decorator.js';
import { resolveIdempotencyKey } from './idempotency-key.js';

const IDEMPOTENCY_KEY_HEADER_DOC = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'Alternative to the idempotency_key body field (1-100 characters). If several are sent they must be equal, otherwise 400.',
};

// Shared response docs for the routes below
const TOO_MANY_REQUESTS_DOC = {
  status: HttpStatus.TOO_MANY_REQUESTS,
  description:
    'The server is busy (SERVER_BUSY) or the database is temporarily unavailable (DB_UNAVAILABLE). Comes with a Retry-After header; retry with the same request.',
  schema: {
    example: {
      statusCode: 429,
      error: 'Too Many Requests',
      reason: 'SERVER_BUSY',
      message:
        'The server is busy; retry shortly (with the same idempotency key)',
    },
  },
};

const CLAIM_BAD_REQUEST_DOC = {
  status: HttpStatus.BAD_REQUEST,
  description:
    'Invalid body (seats must be 1-10 unique strings of at most 10 characters), or the idempotency key is missing, longer than 100 characters, or sent twice with different values',
  schema: {
    example: {
      statusCode: 400,
      message:
        'An idempotency key is required: send idempotency_key in the body or an Idempotency-Key header',
      error: 'Bad Request',
    },
  },
};

const CLAIM_UNAUTHORIZED_DOC = {
  status: HttpStatus.UNAUTHORIZED,
  description:
    "JWT missing, invalid or expired, or the token's user does not exist (reason UNKNOWN_USER)",
};

const CLAIM_FORBIDDEN_DOC = {
  status: HttpStatus.FORBIDDEN,
  description: 'Forbidden - requires a user token (admin tokens cannot hold or reserve)',
};

const CLAIM_NOT_FOUND_DOC = {
  status: HttpStatus.NOT_FOUND,
  description: 'Show not found, or one of the seats does not exist in this show',
  schema: {
    example: {
      statusCode: 404,
      message: 'Show with ID 999 not found',
      error: 'Not Found',
    },
  },
};

const CLAIM_CONFLICT_DOC = {
  status: HttpStatus.CONFLICT,
  description:
    'Declined: a seat is held or reserved by someone else (SEAT_TAKEN), the per-user limit would be exceeded (PER_USER_LIMIT), the idempotency key was already used with a different request (IDEMPOTENCY_KEY_MISMATCH), or another request from this user for this show is in progress (REQUEST_IN_PROGRESS)',
  schema: {
    example: {
      statusCode: 409,
      error: 'Conflict',
      reason: 'SEAT_TAKEN',
      message: 'One or more of the requested seats are already taken',
    },
  },
};

@ApiTags('Shows')
@Controller('shows')
export class ShowController {
  constructor(private readonly showService: ShowService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a new show (admin only)',
    description:
      'Creates a new show with the specified seats (at most 50,000 per show). All seats start "available". Show names do not need to be unique. per_user_limit defaults to 4. Requires an admin token (POST /user/admin-token).',
  })
  @ApiBody({
    type: CreateShowDto,
    examples: {
      validShow: {
        summary: 'Valid show creation request',
        value: {
          name: 'friday-night',
          seats: ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5'],
          price_paise: 25000,
          per_user_limit: 4,
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Show created successfully with all seats in available state',
    type: ShowResponseDto,
    example: {
      id: 1,
      showId: 1,
      name: 'friday-night',
      seats: [
        { seat_number: 'A1', status: 'available' },
        { seat_number: 'A2', status: 'available' },
        { seat_number: 'A3', status: 'available' },
        { seat_number: 'A4', status: 'available' },
        { seat_number: 'A5', status: 'available' },
        { seat_number: 'B1', status: 'available' },
        { seat_number: 'B2', status: 'available' },
        { seat_number: 'B3', status: 'available' },
        { seat_number: 'B4', status: 'available' },
        { seat_number: 'B5', status: 'available' },
      ],
      counts: { available: 10, held: 0, confirmed: 0 },
      total_seats: 10,
      price_paise: 25000,
      per_user_limit: 4,
      created_at: '2024-01-15T10:30:00.000Z',
      updated_at: '2024-01-15T10:30:00.000Z',
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: missing/empty name or longer than 255 characters, seats not an array of 1-50,000 non-empty strings, a seat number longer than 10 characters, price_paise not a positive integer, or per_user_limit not an integer between 1 and 50',
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - JWT token missing, invalid or expired',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Admin role required',
  })
  @ApiResponse({
    status: 409,
    description: 'Duplicate seat numbers in the request',
  })
  @ApiResponse({
    status: 413,
    description: 'Request body larger than 2 MB',
  })
  @ApiResponse(TOO_MANY_REQUESTS_DOC)
  async create(@Body() createShowDto: CreateShowDto): Promise<ShowResponseDto> {
    return this.showService.create(createShowDto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a show by ID',
    description:
      'Returns all show details, every seat with its current status, and counts per status. held = locked by a user until the hold expires (an expired hold is reported as available); confirmed = reserved for good. available + held + confirmed always equals total_seats. Public endpoint - no authentication required.',
  })
  @ApiParam({
    name: 'id',
    description: 'Show ID',
    example: 1,
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Show found with all seats and their status',
    type: ShowResponseDto,
    example: {
      id: 1,
      showId: 1,
      name: 'friday-night',
      seats: [
        { seat_number: 'A1', status: 'confirmed' },
        { seat_number: 'A2', status: 'available' },
        { seat_number: 'A3', status: 'available' },
        { seat_number: 'A4', status: 'held' },
        { seat_number: 'A5', status: 'available' },
        { seat_number: 'B1', status: 'available' },
        { seat_number: 'B2', status: 'available' },
        { seat_number: 'B3', status: 'available' },
        { seat_number: 'B4', status: 'available' },
        { seat_number: 'B5', status: 'available' },
      ],
      counts: { available: 8, held: 1, confirmed: 1 },
      total_seats: 10,
      price_paise: 25000,
      per_user_limit: 4,
      created_at: '2024-01-15T10:30:00.000Z',
      updated_at: '2024-01-15T10:30:00.000Z',
    },
  })
  @ApiResponse({
    status: 400,
    description: 'The show ID is not a positive integer',
    schema: {
      example: {
        statusCode: 400,
        message: 'Invalid show ID',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Show not found',
    schema: {
      example: {
        statusCode: 404,
        message: 'Show with ID 999 not found',
        error: 'Not Found',
      },
    },
  })
  @ApiResponse(TOO_MANY_REQUESTS_DOC)
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ShowResponseDto> {
    return this.showService.findOne(id);
  }

  @Post(':id/hold')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Hold seats for a show (temporary)',
    description:
      'Temporarily locks free seats for the caller (status "held") until held_until; after that the hold lapses and the seats are available again. Turn a hold into a permanent reservation with POST /shows/:id/reserve before it expires. Held seats count toward the per-user limit. All-or-nothing: either every requested seat is held or none is. Identity comes only from the token; any user field in the body is ignored. A retry with the same idempotency key returns the original hold (201, same body).',
  })
  @ApiParam({
    name: 'id',
    description: 'Show ID',
    example: 1,
    type: 'number',
  })
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiBody({
    type: ReserveSeatsDto,
    examples: {
      validHold: {
        summary: 'Valid hold request',
        value: {
          seats: ['A1', 'A2'],
          idempotency_key:
            '9b1f0c2d7e4a4b6c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'Seats held for the user until held_until (also returned, unchanged, for a retry with the same idempotency key)',
    schema: {
      example: {
        reservation_id: '41',
        show_id: '1',
        user_id: '7',
        seats: ['A1', 'A2'],
        amount_paise: 50000,
        status: 'held',
        held_until: '2024-01-15T10:40:00.000Z',
      },
    },
  })
  @ApiResponse(CLAIM_BAD_REQUEST_DOC)
  @ApiResponse(CLAIM_UNAUTHORIZED_DOC)
  @ApiResponse(CLAIM_FORBIDDEN_DOC)
  @ApiResponse(CLAIM_NOT_FOUND_DOC)
  @ApiResponse(CLAIM_CONFLICT_DOC)
  @ApiResponse(TOO_MANY_REQUESTS_DOC)
  async hold(
    @Param('id', ParseIntPipe) showId: number,
    @GetUser() userCtx: { userId: number },
    @Body() holdSeatsDto: ReserveSeatsDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string | string[],
  ) {
    const idempotencyKey = resolveIdempotencyKey(
      holdSeatsDto,
      idempotencyKeyHeader,
    );
    // identity comes only from the token, never from the body
    const result = await this.showService.hold(
      showId,
      { seats: holdSeatsDto.seats, idempotencyKey },
      userCtx.userId,
    );

    return {
      reservation_id: result.reservationId,
      show_id: String(result.showId),
      user_id: String(result.userId),
      seats: result.seats,
      amount_paise: result.amountPaise,
      status: 'held',
      held_until: result.heldUntil,
    };
  }

  @Post(':id/reserve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reserve seats for a show (permanent)',
    description:
      'Reserves seats for good (status "confirmed"); a reserved seat never becomes available again. Accepts seats that are free, or seats the caller currently holds via POST /shows/:id/hold, so holding first is optional. Reserved seats count toward the per-user limit. All-or-nothing: either every requested seat is reserved or none is. Identity comes only from the token; any user field in the body is ignored. A retry with the same idempotency key returns the original reservation (201, same body).',
  })
  @ApiParam({
    name: 'id',
    description: 'Show ID',
    example: 1,
    type: 'number',
  })
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_KEY_HEADER_DOC)
  @ApiBody({
    type: ReserveSeatsDto,
    examples: {
      validReservation: {
        summary: 'Valid show reservation request',
        value: {
          seats: ['A1', 'A2'],
          idempotency_key:
            '3d341232a1148fe0787a90054717e0f5fffc09cdcb611b2069315ca606313fdd',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'Seats reserved for the user (also returned, unchanged, for a retry with the same idempotency key)',
    schema: {
      example: {
        reservation_id: '42',
        show_id: '1',
        user_id: '7',
        seats: ['A1', 'A2'],
        amount_paise: 50000,
        status: 'confirmed',
      },
    },
  })
  @ApiResponse(CLAIM_BAD_REQUEST_DOC)
  @ApiResponse(CLAIM_UNAUTHORIZED_DOC)
  @ApiResponse(CLAIM_FORBIDDEN_DOC)
  @ApiResponse(CLAIM_NOT_FOUND_DOC)
  @ApiResponse(CLAIM_CONFLICT_DOC)
  @ApiResponse(TOO_MANY_REQUESTS_DOC)
  async reserve(
    @Param('id', ParseIntPipe) showId: number,
    @GetUser() userCtx: { userId: number },
    @Body() reserveSeatsDto: ReserveSeatsDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string | string[],
  ) {
    const idempotencyKey = resolveIdempotencyKey(
      reserveSeatsDto,
      idempotencyKeyHeader,
    );
    // identity comes only from the token, never from the body
    const result = await this.showService.reserve(
      showId,
      { seats: reserveSeatsDto.seats, idempotencyKey },
      userCtx.userId,
    );

    return {
      reservation_id: result.reservationId,
      show_id: String(result.showId),
      user_id: String(result.userId),
      seats: result.seats,
      amount_paise: result.amountPaise,
      status: 'confirmed',
    };
  }
}