import { ValueType, type Attributes, type HrTime } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DataPointType,
  type CollectionResult,
  type DataPoint,
  type Histogram,
  type MetricData,
  type MetricProducer,
} from '@opentelemetry/sdk-metrics';
import { register } from 'prom-client';
import { METRICS } from './metric-names.js';

/** Only our custom metrics are bridged; OTel's own runtime instrumentation covers process/Node stats. */
const BRIDGED = new Set<string>(Object.values(METRICS));

/** prom-client values are totals since the process started, so cumulative series start here. */
const PROCESS_START: HrTime = toHrTime(performance.timeOrigin);

interface PromValue {
  value: number;
  labels: Record<string, string | number | undefined>;
  metricName?: string;
}
interface PromMetric {
  name: string;
  help: string;
  type: unknown; // 'counter' | 'gauge' | 'histogram' | 'summary' at runtime
  values: PromValue[];
}

/**
 * Feeds the prom-client registry (the one served at /metrics) into the OpenTelemetry metric
 * export, so the same custom metrics also reach Traceway over OTLP. Registered on the
 * PeriodicExportingMetricReader in src/instrumentation.ts; called on every export (every 10s).
 * Counters become monotonic cumulative sums, gauges stay gauges, histograms keep their buckets.
 */
export class PromClientMetricProducer implements MetricProducer {
  async collect(): Promise<CollectionResult> {
    const errors: unknown[] = [];
    let metrics: MetricData[] = [];

    try {
      const now = toHrTime(Date.now());
      const all = (await register.getMetricsAsJSON()) as unknown as PromMetric[];
      metrics = all
        .filter((m) => BRIDGED.has(m.name))
        .map((m) => toOtel(m, now))
        .filter((m): m is MetricData => m !== undefined);
    } catch (error) {
      // never break the SDK's own export because of the bridge
      errors.push(error);
    }

    return {
      resourceMetrics: {
        resource: resourceFromAttributes({}),
        scopeMetrics: [
          { scope: { name: 'event-booking-api/prom-client' }, metrics },
        ],
      },
      errors,
    };
  }
}

function toOtel(metric: PromMetric, now: HrTime): MetricData | undefined {
  const descriptor = {
    name: metric.name,
    description: metric.help,
    unit: metric.name.endsWith('_seconds') ? 's' : '',
    valueType: ValueType.DOUBLE,
  };

  switch (String(metric.type)) {
    case 'counter':
      return {
        descriptor,
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPointType: DataPointType.SUM,
        isMonotonic: true,
        dataPoints: metric.values.map((v) => point(v.labels, v.value, now)),
      };
    case 'gauge':
      return {
        descriptor,
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPointType: DataPointType.GAUGE,
        dataPoints: metric.values.map((v) => point(v.labels, v.value, now)),
      };
    case 'histogram':
      return {
        descriptor,
        aggregationTemporality: AggregationTemporality.CUMULATIVE,
        dataPointType: DataPointType.HISTOGRAM,
        dataPoints: histogramPoints(metric, now),
      };
    default:
      return undefined; // summaries aren't used here
  }
}

function point(
  labels: PromValue['labels'],
  value: number,
  now: HrTime,
): DataPoint<number> {
  return {
    startTime: PROCESS_START,
    endTime: now,
    attributes: toAttributes(labels),
    value,
  };
}

/**
 * prom-client reports a histogram as `<name>_bucket` values (cumulative counts per `le`
 * boundary, ending with +Inf), plus `<name>_sum` and `<name>_count`, per label set.
 * OTel wants the finite boundaries and a non-cumulative count per bucket (one extra for +Inf).
 */
function histogramPoints(
  metric: PromMetric,
  now: HrTime,
): DataPoint<Histogram>[] {
  const series = new Map<
    string,
    {
      labels: Attributes;
      buckets: { le: number; cumulative: number }[];
      sum: number;
      count: number;
    }
  >();

  for (const v of metric.values) {
    const { le, ...rest } = v.labels;
    const labels = toAttributes(rest);
    const key = JSON.stringify(Object.entries(labels).sort());
    let s = series.get(key);
    if (!s) {
      s = { labels, buckets: [], sum: 0, count: 0 };
      series.set(key, s);
    }
    if (v.metricName?.endsWith('_bucket')) {
      s.buckets.push({
        le: le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le),
        cumulative: v.value,
      });
    } else if (v.metricName?.endsWith('_sum')) {
      s.sum = v.value;
    } else if (v.metricName?.endsWith('_count')) {
      s.count = v.value;
    }
  }

  return [...series.values()].map((s) => {
    const sorted = s.buckets.sort((a, b) => a.le - b.le);
    const boundaries = sorted
      .filter((b) => Number.isFinite(b.le))
      .map((b) => b.le);
    const counts = sorted.map((b, i) =>
      i === 0 ? b.cumulative : b.cumulative - sorted[i - 1].cumulative,
    );
    // make sure there is exactly one count per boundary plus the +Inf bucket
    while (counts.length < boundaries.length + 1) counts.push(0);

    return {
      startTime: PROCESS_START,
      endTime: now,
      attributes: s.labels,
      value: {
        buckets: { boundaries, counts },
        sum: s.sum,
        count: s.count,
      },
    };
  });
}

function toAttributes(labels: PromValue['labels']): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined) attributes[key] = value;
  }
  return attributes;
}

function toHrTime(epochMs: number): HrTime {
  const seconds = Math.floor(epochMs / 1000);
  return [seconds, Math.round((epochMs - seconds * 1000) * 1e6)];
}
