import { describe, expect, it } from 'vitest';

import {
  formatAuditBytes,
  getDefaultAuditTimeWindow,
  parseAuditDate,
  toIsoOrUndefined,
} from './timeWindow';

describe('audit timeWindow utils', () => {
  it('builds a 7-day half-open window ending at the given end', () => {
    const end = new Date('2026-03-15T12:30:00.000Z');
    const { from, to } = getDefaultAuditTimeWindow(7, end, { alignStartOfDay: false });
    expect(to.toISOString()).toBe(end.toISOString());
    expect(from.getTime()).toBe(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('aligns from to local start of day only when span stays within max days', () => {
    // Midday end: midnight alignment of (end - 7d) would exceed 7×24h — use exact span.
    const midday = new Date('2026-03-15T15:00:00.000Z');
    const middayWindow = getDefaultAuditTimeWindow(7, midday);
    expect(middayWindow.to.getTime() - middayWindow.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    // Already at local midnight: alignment does not lengthen the window.
    const midnightLocal = new Date();
    midnightLocal.setHours(0, 0, 0, 0);
    const aligned = getDefaultAuditTimeWindow(7, midnightLocal);
    expect(aligned.from.getHours()).toBe(0);
    expect(aligned.from.getMinutes()).toBe(0);
    expect(aligned.to.getTime() - aligned.from.getTime()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('serializes and parses ISO dates safely', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(toIsoOrUndefined(new Date(iso))).toBe(iso);
    expect(toIsoOrUndefined(undefined)).toBeUndefined();
    expect(parseAuditDate(iso)?.toISOString()).toBe(iso);
    expect(parseAuditDate('not-a-date')).toBeUndefined();
  });

  it('formats byte sizes', () => {
    expect(formatAuditBytes(null)).toBe('—');
    expect(formatAuditBytes(500)).toBe('500 B');
    expect(formatAuditBytes(2048)).toBe('2.0 KB');
    expect(formatAuditBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
