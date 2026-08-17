import { describe, expect, it } from 'vitest';

import {
  describeInterval,
  EM_DASH,
  formatBytes,
  formatDateTime,
  formatDelay,
  shortDigest,
  shortInstanceId,
  summarizeTraffic,
} from './format';

describe('formatBytes', () => {
  it('shows zero as a real value, not as unknown', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('scales into binary units', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('renders an em dash when the value is unknown', () => {
    expect(formatBytes(null)).toBe(EM_DASH);
    expect(formatBytes(undefined)).toBe(EM_DASH);
  });
});

describe('formatDelay', () => {
  it('renders milliseconds and marks a never-measured node', () => {
    expect(formatDelay(123.4)).toBe('123 ms');
    expect(formatDelay(null)).toBe(EM_DASH);
  });
});

describe('formatDateTime', () => {
  it('rejects an unparsable timestamp instead of printing "Invalid Date"', () => {
    expect(formatDateTime('not-a-date')).toBe(EM_DASH);
    expect(formatDateTime(null)).toBe(EM_DASH);
    expect(formatDateTime('2026-08-17T00:00:00.000Z')).not.toBe(EM_DASH);
  });
});

describe('describeInterval', () => {
  it('returns a unit key + count so the label can be translated', () => {
    expect(describeInterval(600)).toEqual({ unit: 'minute', value: 10 });
    expect(describeInterval(7200)).toEqual({ unit: 'hour', value: 2 });
    expect(describeInterval(86_400)).toEqual({ unit: 'day', value: 1 });
  });

  it('never invents an interval for an unknown value', () => {
    expect(describeInterval(null)).toBeNull();
    expect(describeInterval(undefined)).toBeNull();
  });
});

describe('summarizeTraffic', () => {
  it('reports an em dash when the provider published no quota at all', () => {
    expect(summarizeTraffic(null).text).toBe(EM_DASH);
    expect(
      summarizeTraffic({ download: null, expireAt: null, total: null, upload: null }).text,
    ).toBe(EM_DASH);
  });

  it('sums upload and download against the total', () => {
    const summary = summarizeTraffic({
      download: 3 * 1024 ** 3,
      expireAt: '2026-09-01T00:00:00.000Z',
      total: 10 * 1024 ** 3,
      upload: 1024 ** 3,
    });
    expect(summary.text).toBe('4.0 GB / 10.0 GB');
    expect(summary.ratio).toBeCloseTo(0.4);
    expect(summary.expireAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('never reports a ratio above 1 when the quota is already exceeded', () => {
    const summary = summarizeTraffic({ download: 20, expireAt: null, total: 10, upload: 0 });
    expect(summary.ratio).toBe(1);
  });
});

describe('shortDigest / shortInstanceId', () => {
  it('gives an operator enough of the digest to eyeball', () => {
    expect(shortDigest('8ad44e28fe72be4640254b96741b677f')).toBe('8ad44e28fe72');
    expect(shortDigest(null)).toBe(EM_DASH);
  });

  it('leaves short instance ids alone and truncates long ones', () => {
    expect(shortInstanceId('pinst_abc')).toBe('pinst_abc');
    expect(shortInstanceId('pinst_abcdefghijklmnop')).toBe('pinst_abcdef…');
  });
});
