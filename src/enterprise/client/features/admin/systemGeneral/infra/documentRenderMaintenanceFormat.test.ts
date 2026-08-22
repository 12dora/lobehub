import { describe, expect, it } from 'vitest';

import {
  EM_DASH,
  formatAbsolute,
  formatArtifactBytes,
  formatCount,
  relativeLabel,
} from './documentRenderMaintenanceFormat';

describe('documentRenderMaintenanceFormat', () => {
  it('reports an empty artifact store as 0 B rather than as "not measured"', () => {
    expect(formatArtifactBytes(0)).toBe('0 B');
    expect(formatArtifactBytes(null)).toBe(EM_DASH);
    expect(formatArtifactBytes(undefined)).toBe(EM_DASH);
  });

  it('climbs binary units and drops the decimal once the number is wide', () => {
    expect(formatArtifactBytes(2048)).toBe('2.0 KB');
    expect(formatArtifactBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatArtifactBytes(200 * 1024 * 1024)).toBe('200 MB');
    expect(formatArtifactBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('keeps a zero count visible and an unmeasured one blank', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(null)).toBe(EM_DASH);
  });

  it('buckets a timestamp into the unit an operator would say out loud', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    expect(relativeLabel('2026-08-22T11:59:30.000Z', now)).toEqual({ key: 'justNow' });
    expect(relativeLabel('2026-08-22T11:20:00.000Z', now)).toEqual({ count: 40, key: 'minutes' });
    expect(relativeLabel('2026-08-22T04:00:00.000Z', now)).toEqual({ count: 8, key: 'hours' });
    expect(relativeLabel('2026-08-19T12:00:00.000Z', now)).toEqual({ count: 3, key: 'days' });
  });

  it('treats a missing or unparsable timestamp as "never"', () => {
    expect(relativeLabel(null)).toBeNull();
    expect(relativeLabel('not-a-date')).toBeNull();
    expect(formatAbsolute(null)).toBe(EM_DASH);
    expect(formatAbsolute('not-a-date')).toBe(EM_DASH);
  });

  /** A clock skew must not print "in 3 minutes" on a panel that only ever looks backwards. */
  it('clamps a future timestamp to "just now"', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    expect(relativeLabel('2026-08-22T12:05:00.000Z', now)).toEqual({ key: 'justNow' });
  });
});
