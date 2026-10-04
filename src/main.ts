import dns from 'dns';
import net from 'net';
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

import './instrumentation.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppConfigService } from './config/config.service.js';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { HttpMetrics } from './metrics/http-metrics.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // 2 MB: a show of up to 50,000 seat numbers (MAX_SEATS_PER_SHOW) fits comfortably
    new FastifyAdapter({ bodyLimit: 10 * 1024 * 1024 }),
    { bufferLogs: true },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      // Unknown body fields are stripped, not rejected. Identity comes only from the JWT, so a
      // spoofed field such as user_id is simply discarded and the request acts as the token's user.
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // graceful shutdown on SIGTERM/SIGINT: readiness goes 503, in-flight requests finish, the DB
  // pool closes, telemetry is flushed (src/common/lifecycle/shutdown.service.ts)
  app.enableShutdownHooks();

  // count every HTTP response (incl. guard and exception-filter responses) for /metrics
  app.get(HttpMetrics).register(app.getHttpAdapter().getInstance());

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);

  const swaggerOptions = new DocumentBuilder()
    .setTitle('Concurrent Event Booking Service')
    .setDescription('Service to manage the seat booking for events')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerOptions);

  SwaggerModule.setup('docs', app, document);

  await app.listen(Number(config.port), '0.0.0.0');
  logger.log(`Server started on port ${config.port}`);
  logger.log(`Swagger Docs available at http://localhost:${config.port}/docs`);
}
await bootstrap();
