import {
  BeforeApplicationShutdown,
  Global,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { otelSdk } from '../../instrumentation.js';

/** Hard limit for a shutdown, below Azure Container Apps' default 30s termination grace period. */
const SHUTDOWN_DEADLINE_MS = 25_000;

/**
 * Graceful shutdown (enabled by app.enableShutdownHooks() in main.ts). On SIGTERM/SIGINT:
 *   1. beforeApplicationShutdown: mark the app as shutting down, so /health/readiness answers 503
 *      and the platform stops routing new requests here; start a deadline timer.
 *   2. Nest closes the HTTP server (in-flight requests finish) and the TypeORM pool.
 *   3. onApplicationShutdown: flush the last traces, metrics and logs to the OTLP backend.
 */
@Injectable()
export class ShutdownService
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private shuttingDown = false;

  constructor(
    @InjectPinoLogger(ShutdownService.name)
    private readonly logger: PinoLogger,
  ) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  beforeApplicationShutdown(signal?: string): void {
    this.shuttingDown = true;
    this.logger.info({ signal }, 'shutting down: draining in-flight requests');
    // never outlive the platform's grace period; unref() so this timer alone keeps nothing alive
    setTimeout(() => {
      this.logger.error('shutdown deadline exceeded, exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await otelSdk.shutdown();
    } catch (error) {
      this.logger.warn({ err: error }, 'telemetry flush failed during shutdown');
    }
  }
}

/** Global, so the health controller (readiness) can read the shutdown flag. */
@Global()
@Module({
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class LifecycleModule {}
