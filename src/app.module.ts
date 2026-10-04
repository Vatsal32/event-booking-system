import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { AppConfigService } from './config/config.service.js';
import { LoggerModule } from 'nestjs-pino';
import { UserModule } from './user/user.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module.js';
import { ShowModule } from './show/show.module.js';
import { HealthModule } from './health/health.module.js';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { MetricsModule } from './metrics/metrics.module.js';
import { LifecycleModule } from './common/lifecycle/shutdown.service.js';
import { readFileSync } from 'node:fs';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { requestId } from './common/logging/request-id.js';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
    MetricsModule,
    LifecycleModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: requestId,
          transport:
            config.env === 'development'
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: true,
                  },
                }
              : undefined,
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        type: 'postgres',
        host: config.database.HOST,
        port: config.database.PORT,
        username: config.database.USERNAME,
        password: config.database.PASSWORD,
        database: config.database.DATABASE,
        ssl: config.database.SSL
          ? {
              rejectUnauthorized: true,
              ca: readFileSync(config.database.CERT_PATH, 'utf8'),
            }
          : undefined,
        poolSize: config.database.MAX_CONNECTIONS,
        cache: true,
        autoLoadEntities: true,
        entities: [],
        synchronize: true,
        logging: false,
        extra: {
          max: config.database.MAX_CONNECTIONS,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
      }),
    }),
    ConfigModule,
    AuthModule,
    HealthModule,
    UserModule,
    ShowModule,
  ],
  providers: [
    // turns infrastructure errors (pool timeouts, DB down) into 429 instead of 500 on every route
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
