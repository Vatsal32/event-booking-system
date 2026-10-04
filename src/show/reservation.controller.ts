import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ShowService } from './show.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { GetUser } from '../auth/get-user.decorator.js';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationController {
  constructor(private readonly showService: ShowService) {}

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancel your hold or reservation',
    description:
      'Releases the seats of one of your holds (POST /shows/:id/hold) or reservations (POST /shows/:id/reserve) back to available; they can be booked again immediately. Only the owner can cancel: identity comes from the token, and someone else\'s reservation id gets 404 exactly like an unknown one. Seats that someone else has taken since (for example after your hold expired) are never touched. Cancelling twice is harmless: the second call returns 200 with released_seats empty.',
  })
  @ApiParam({
    name: 'id',
    description: 'reservation_id returned by POST /shows/:id/hold or /reserve',
    example: 42,
    type: 'number',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Cancelled; released_seats lists the seats returned to available',
    schema: {
      example: {
        reservation_id: '42',
        show_id: '1',
        status: 'cancelled',
        released_seats: ['A1', 'A2'],
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'The reservation ID is not a positive integer',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT missing, invalid or expired',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - requires a user token',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No such reservation for this user (unknown id, or someone else\'s)',
    schema: {
      example: {
        statusCode: 404,
        message: 'Reservation 42 not found',
        error: 'Not Found',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Another request from this user for the same show is in progress (REQUEST_IN_PROGRESS); retry shortly',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'The server is busy or the database is temporarily unavailable; retry after the Retry-After header',
  })
  async cancel(
    @Param('id', ParseIntPipe) reservationId: number,
    @GetUser() userCtx: { userId: number },
  ) {
    // identity comes only from the token, never from the request
    const result = await this.showService.cancel(reservationId, userCtx.userId);
    return {
      reservation_id: result.reservationId,
      show_id: String(result.showId),
      status: 'cancelled',
      released_seats: result.releasedSeats,
    };
  }
}
