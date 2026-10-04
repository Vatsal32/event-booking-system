import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { config } from 'dotenv';
import { PromClientMetricProducer } from './metrics/prom-client-producer.js';

config();
const TRACEWAY_URL = process.env.TRACEWAY_URL;
const TRACEWAY_SECRET = process.env.TRACEWAY_SECRET;
const headers = { Authorization: `Bearer ${TRACEWAY_SECRET}` };

/** Shut down (flushing telemetry) by ShutdownService during Nest's graceful shutdown. */
export const otelSdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'event-booking-api',
    'service.version': '0.0.1',
  }),

  traceExporter: new OTLPTraceExporter({
    url: `${TRACEWAY_URL}/api/otel/v1/traces`,
    headers,
  }),

  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${TRACEWAY_URL}/api/otel/v1/metrics`,
        headers,
      }),
      exportIntervalMillis: 10_000,
      // also send our custom prom-client metrics (the ones on /metrics) to Traceway
      metricProducers: [new PromClientMetricProducer()],
    }),
  ],

  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: `${TRACEWAY_URL}/api/otel/v1/logs`,
        headers,
      }),
    }),
  ],

  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-router': { enabled: false },
    }),
  ],
});

otelSdk.start();

// No signal handlers here: app.enableShutdownHooks() (main.ts) drains requests first, then
// ShutdownService (src/common/lifecycle/shutdown.service.ts) calls otelSdk.shutdown().
