import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { LABEL_VALUES, METRICS } from './metric-names.js';

@Injectable()
export class MetricsInitializer implements OnModuleInit {
  constructor(
    @InjectMetric(METRICS.httpResponsesByClass)
    private readonly httpResponsesByClass: Counter<string>,
    @InjectMetric(METRICS.reservationsDeclined)
    private readonly reservationsDeclined: Counter<string>,
    @InjectMetric(METRICS.dbErrors)
    private readonly dbErrors: Counter<string>,
    @InjectMetric(METRICS.claimRetries)
    private readonly claimRetries: Counter<string>,
    @InjectMetric(METRICS.seatCacheRejections)
    private readonly seatCacheRejections: Counter<string>,
    @InjectMetric(METRICS.reservationsCancelled)
    private readonly reservationsCancelled: Counter<string>,
  ) {}

  onModuleInit(): void {
    for (const status_class of LABEL_VALUES.statusClass) {
      this.httpResponsesByClass.inc({ status_class }, 0);
    }
    for (const reason of LABEL_VALUES.declineReason) {
      for (const action of LABEL_VALUES.claimAction) {
        this.reservationsDeclined.inc({ reason, action }, 0);
      }
    }
    for (const reason of LABEL_VALUES.dbErrorReason) {
      this.dbErrors.inc({ reason, code: 'none' }, 0);
    }
    for (const action of LABEL_VALUES.retryAction) {
      for (const reason of LABEL_VALUES.retryReason) {
        for (const outcome of LABEL_VALUES.retryOutcome) {
          this.claimRetries.inc({ action, reason, outcome }, 0);
        }
      }
    }
    for (const stage of LABEL_VALUES.cacheStage) {
      this.seatCacheRejections.inc({ stage }, 0);
    }
    for (const kind of LABEL_VALUES.cancelKind) {
      this.reservationsCancelled.inc({ kind }, 0);
    }
  }
}
