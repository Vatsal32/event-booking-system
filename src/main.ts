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
    new FastifyAdapter({ bodyLimit: 10 * 1024 * 1024 }),
    { bufferLogs: true },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

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
