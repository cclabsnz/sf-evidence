import { AuditTrailCollector } from './auditTrail.js';
import { LimitsCollector } from './limits.js';
import type { Collector } from '../types/collector.js';
import type { SourceId } from '../types/record.js';

/**
 * The single registration point for collectors. `explain` iterates this, so a collector
 * that is not registered here cannot silently issue a query the operator was not shown.
 */
export const COLLECTORS: Partial<Record<SourceId, Collector>> = {
  'audit-trail': new AuditTrailCollector(),
  limits: new LimitsCollector(),
};

export function getCollector(source: SourceId): Collector {
  const c = COLLECTORS[source];
  if (!c) {
    throw new Error(
      `Source '${source}' is not available in this release. Available: ${Object.keys(COLLECTORS).join(', ')}.`,
    );
  }
  return c;
}
