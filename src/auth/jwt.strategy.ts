import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Identity comes from the signed token only: passport-jwt has already verified the signature and
 * expiry, so there is no per-request database lookup (one less round trip and pool checkout on
 * every request, and no 500 when the pool is busy). Trade-off: a deleted user's token stays
 * valid until it expires (1h); a reserve for a user id that doesn't exist is rejected with 401
 * by the seats -> users foreign key (see ShowService.toHttpError).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: { sub: unknown; username: string; role: unknown }) {
    if (payload.sub === 0 && payload.role === 'admin') {
      return { userId: 0, username: 'admin', role: 'admin' };
    }

    if (
      payload.role !== 'user' ||
      !Number.isInteger(payload.sub) ||
      (payload.sub as number) <= 0
    ) {
      throw new UnauthorizedException('Invalid token');
    }

    return {
      userId: payload.sub as number,
      username: payload.username,
      role: payload.role,
    };
  }
}
