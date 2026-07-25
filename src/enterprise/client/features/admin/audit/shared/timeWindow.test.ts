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

    // Fixed local midnight (constructed in local TZ, independent of "today").
    // setHours(0,0,0,0) on a fixed calendar day — alignment must not lengthen past max.
    const midnightLocal = new Date(2026, 2, 15, 0, 0, 0, 0); // 2026-03-15 local midnight
    const aligned = getDefaultAuditTimeWindow(7, midnightLocal);
    expect(aligned.to.getTime()).toBe(midnightLocal.getTime());
    expect(aligned.to.getTime() - aligned.from.getTime()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
    // When alignment is kept, from is local midnight; when skipped, exact span is used.
    // Either way the result stays within the duration cap.
    expect(aligned.from.getTime()).toBeLessThanOrEqual(midnightLocal.getTime());
  });

  it('keeps the max-span cap across spring-forward (US DST start 2026-03-08)', () => {
    // US Pacific spring-forward: 2026-03-08 02:00 → 03:00. A 7×24h subtraction from
    // a post-transition local midnight can land off local midnight; the cap still holds.
    const end = new Date(2026, 2, 15, 0, 0, 0, 0); // local midnight after spring-forward week
    const window = getDefaultAuditTimeWindow(7, end);
    expect(window.to.getTime() - window.from.getTime()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
    // Exact duration is either exactly 7d (no alignment) or shorter (aligned midnight).
    expect(window.to.getTime() - window.from.getTime()).toBeGreaterThan(0);
  });

  it('keeps the max-span cap across fall-back (US DST end 2026-11-01)', () => {
    // US Pacific fall-back: 2026-11-01 02:00 → 01:00. Exact 7×24h may not match local midnight.
    const end = new Date(2026, 10, 8, 0, 0, 0, 0); // local midnight after fall-back week
    const window = getDefaultAuditTimeWindow(7, end);
    expect(window.to.getTime() - window.from.getTime()).toBeLessThanOrEqual(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(window.to.getTime() - window.from.getTime()).toBeGreaterThan(0);
  });

  it('never lengthens past the exact duration even when alignment would', () => {
    // End not at midnight: alignment of (end - 7d) to local midnight is earlier than cap.
    const end = new Date(2026, 5, 15, 15, 30, 0, 0);
    const window = getDefaultAuditTimeWindow(7, end);
    expect(window.to.getTime() - window.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
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
