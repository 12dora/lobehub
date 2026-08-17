/** Frozen-filter + live-policy resolution for an audit export attempt. */

import type { PlatformAuditExportFilterSnapshot } from '@/database/models/platform';

import { AuditExportInvalidFilterError } from './exportWorkerErrors';
import type { ExportTimeWindow } from './exportWorkerShared';

/** Align with adminAuditPolicyUpdateInputSchema max bounds. */
const FROZEN_MAX_EXPORT_ROWS_BOUND = 1_000_000;
const FROZEN_EXPORT_ARTIFACT_RETENTION_DAYS_BOUND = 365;

/**
 * Require a valid ISO timestamp from the frozen snapshot.
 * Missing or invalid values terminal-fail — never silently widen the scan window.
 */
const parseRequiredIsoDate = (value: string | undefined, field: 'from' | 'to'): Date => {
  if (value == null || value === '') {
    throw new AuditExportInvalidFilterError(
      `${field} required in frozen filter snapshot for export`,
    );
  }
  if (typeof value !== 'string') {
    throw new AuditExportInvalidFilterError(`Invalid frozen ${field}: must be an ISO-8601 string`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AuditExportInvalidFilterError(`Invalid frozen ${field}: ${value}`);
  }
  return d;
};

/**
 * Prefer frozen snapshot when present and valid; absent → live policy (legacy rows).
 * Present but non-positive / non-integer / over safe schema bounds → terminal fail.
 * Never silently coerce invalid caps into a fallback that widens the export.
 */
const resolveFrozenPositiveInt = (
  snapshot: number | undefined,
  live: number,
  bounds: { field: string; max: number },
): number => {
  if (snapshot === undefined) {
    return Math.max(1, Math.min(bounds.max, Math.floor(live)));
  }
  if (
    typeof snapshot !== 'number' ||
    !Number.isInteger(snapshot) ||
    snapshot < 1 ||
    snapshot > bounds.max
  ) {
    throw new AuditExportInvalidFilterError(
      `Invalid frozen ${bounds.field}: ${String(snapshot)} (expected integer 1..${bounds.max})`,
    );
  }
  return snapshot;
};

export const resolveExportExecutionPlan = (params: {
  filterSnapshot: PlatformAuditExportFilterSnapshot | null | undefined;
  livePolicy: {
    exportArtifactRetentionDays: number;
    maxExportRows: number;
  };
}): {
  exportArtifactRetentionDays: number;
  filter: PlatformAuditExportFilterSnapshot;
  maxExportRows: number;
  snapshotAt: Date;
  snapshotWindow: ExportTimeWindow;
  timeWindow: ExportTimeWindow;
} => {
  const filter = params.filterSnapshot ?? {};
  // Time window is mandatory: invalid/missing from|to must never widen to full-table scan.
  const timeWindow: ExportTimeWindow = {
    from: parseRequiredIsoDate(filter.from, 'from'),
    to: parseRequiredIsoDate(filter.to, 'to'),
  };
  const maxExportRows = resolveFrozenPositiveInt(
    filter.maxExportRows,
    params.livePolicy.maxExportRows,
    {
      field: 'maxExportRows',
      max: FROZEN_MAX_EXPORT_ROWS_BOUND,
    },
  );
  const exportArtifactRetentionDays = resolveFrozenPositiveInt(
    filter.exportArtifactRetentionDays,
    params.livePolicy.exportArtifactRetentionDays,
    {
      field: 'exportArtifactRetentionDays',
      max: FROZEN_EXPORT_ARTIFACT_RETENTION_DAYS_BOUND,
    },
  );
  // Point-in-time watermark: never include rows created after export execution starts.
  const snapshotAt = new Date();
  const snapshotWindow: ExportTimeWindow = {
    from: timeWindow.from,
    to: timeWindow.to.getTime() < snapshotAt.getTime() ? timeWindow.to : snapshotAt,
  };
  return {
    exportArtifactRetentionDays,
    filter,
    maxExportRows,
    snapshotAt,
    snapshotWindow,
    timeWindow,
  };
};
