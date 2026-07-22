// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { resolveAuditTimeWindow } from './timeWindow';

describe('resolveAuditTimeWindow', () => {
  it('defaults to maxListWindowDays ending at now when from/to omitted', () => {
    const before = Date.now();
    const window = resolveAuditTimeWindow({ maxListWindowDays: 30 });
    const after = Date.now();
    expect(window.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(window.to.getTime()).toBeLessThanOrEqual(after);
    const spanDays = (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(30, 5);
  });

  it('accepts windows within maxListWindowDays', () => {
    const ok = resolveAuditTimeWindow({
      from: new Date('2020-01-01T00:00:00.000Z'),
      maxListWindowDays: 90,
      to: new Date('2020-02-01T00:00:00.000Z'),
    });
    expect(ok.from.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(ok.to.toISOString()).toBe('2020-02-01T00:00:00.000Z');
  });

  it('rejects windows exceeding maxListWindowDays', () => {
    expect(() =>
      resolveAuditTimeWindow({
        from: new Date('2020-01-01T00:00:00.000Z'),
        maxListWindowDays: 30,
        to: new Date('2020-06-01T00:00:00.000Z'),
      }),
    ).toThrow();
  });

  it('rejects from >= to', () => {
    expect(() =>
      resolveAuditTimeWindow({
        from: new Date('2020-02-01T00:00:00.000Z'),
        maxListWindowDays: 30,
        to: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ).toThrow();
  });
});
