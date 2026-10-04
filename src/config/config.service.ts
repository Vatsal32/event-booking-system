import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseConfig, Environment } from './config.js';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get env(): Environment {
    return this.configService.getOrThrow<Environment>('NODE_ENV');
  }

  get port(): string {
    return this.configService.getOrThrow<string>('PORT');
  }

  get logLevel(): string {
    return this.configService.getOrThrow<string>('LOG_LEVEL');
  }

  get jwtSecret(): string {
    return this.configService.getOrThrow<string>('JWT_SECRET');
  }

  get adminKey(): string {
    return this.configService.getOrThrow<string>('ADMIN_KEY');
  }

  get database(): DatabaseConfig {
    return this.configService.getOrThrow<DatabaseConfig>('database');
  }

  get lockDurationMin(): number {
    return this.configService.getOrThrow<number>(
      'SEAT_LOCK_EXPIRATION_MINUTES',
    );
  }

  get tracewayEndpoint(): string {
    return this.configService.getOrThrow<string>('TRACEWAY_URL');
  }

  get tracewayToken(): string {
    return this.configService.getOrThrow<string>('TRACEWAY_SECRET');
  }
}