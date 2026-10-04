import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { plainToInstance, Transform, Type } from 'class-transformer';

export enum Environment {
  Development = 'development',
  Production = 'production',
}

export class DatabaseConfig {
  @IsString()
  HOST: string;

  @IsNumber()
  @Min(0)
  @Max(65535)
  @Transform(({ value }) => Number(value))
  PORT: number;

  @IsString()
  USERNAME: string;

  @IsString()
  PASSWORD: string;

  @IsString()
  DATABASE: string;

  @IsBoolean()
  SSL: boolean;

  @IsString()
  CERT_PATH: string;

  @IsNumber()
  MAX_CONNECTIONS: number;
}

export class AppConfig {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsString()
  @MinLength(32)
  @MaxLength(256)
  JWT_SECRET: string;

  @IsString()
  @MinLength(32)
  @MaxLength(256)
  ADMIN_KEY: string;

  @IsNumber()
  @Transform(({ value }) => Number(value))
  PORT: number = 3000;

  @ValidateNested()
  @Type(() => DatabaseConfig)
  database: DatabaseConfig;

  @IsNumber()
  SEAT_LOCK_EXPIRATION_MINUTES: number = 10;

  @IsString()
  LOG_LEVEL: string = 'debug';

  @IsString()
  @Transform(({ value }) => value || 'http://localhost:4200')
  TRACEWAY_URL: string = 'http://localhost:4200';

  @IsString()
  TRACEWAY_SECRET: string = 'TRACEWAY_TOKEN';

  @IsNumber()
  DB_MAX_CONNECTIONS: number = 10;
}

export function validateConfig(config: Record<string, unknown>) {
  const preFormattedConfig = {
    NODE_ENV: config.NODE_ENV,
    PORT: config.PORT,
    JWT_SECRET: config.JWT_SECRET,
    ADMIN_KEY: config.ADMIN_KEY,
    LOG_LEVEL: config.LOG_LEVEL,
    TRACEWAY_URL: config.TRACEWAY_URL,
    TRACEWAY_SECRET: config.TRACEWAY_SECRET,
    SEAT_LOCK_EXPIRATION_MINUTES: config.SEAT_LOCK_EXPIRATION_MINUTES,
    database: {
      HOST: config.DB_HOST,
      PORT: config.DB_PORT,
      USERNAME: config.DB_USERNAME,
      PASSWORD: config.DB_PASSWORD,
      DATABASE: config.DB_DATABASE,
      SSL: config.DB_SSL === "true",
      CERT_PATH: config.DB_CERT_PATH,
      MAX_CONNECTIONS: config.DB_MAX_CONNECTIONS,
    },
  };

  const validatedConfig = plainToInstance(AppConfig, preFormattedConfig, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Config validation error: ${errors.toString()}`);
  }

  return validatedConfig;
}
