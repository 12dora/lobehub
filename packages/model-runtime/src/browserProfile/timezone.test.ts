import { describe, expect, it } from 'vitest';

import { BROWSER_PROFILE_TIMEZONE_POOL, generateBrowserDeviceProfile } from './generate';
import {
  resolveProfileTimezone,
  resolveTimezoneJsDateSuffix,
  resolveTimezoneOffsetMinutes,
} from './timezone';

const SUMMER = new Date('2026-08-01T12:00:00Z');
const WINTER = new Date('2026-01-15T12:00:00Z');

describe('live timezone resolution', () => {
  it('follows DST for a northern-hemisphere zone', () => {
    expect(resolveTimezoneOffsetMinutes('America/New_York', SUMMER)).toBe(240);
    expect(resolveTimezoneOffsetMinutes('America/New_York', WINTER)).toBe(300);
    expect(resolveTimezoneJsDateSuffix('America/New_York', SUMMER)).toBe(
      'GMT-0400 (Eastern Daylight Time)',
    );
    expect(resolveTimezoneJsDateSuffix('America/New_York', WINTER)).toBe(
      'GMT-0500 (Eastern Standard Time)',
    );
  });

  it('follows DST for a southern-hemisphere zone and stays put in a zone without DST', () => {
    expect(resolveTimezoneOffsetMinutes('Australia/Sydney', WINTER)).toBe(-660);
    expect(resolveTimezoneOffsetMinutes('Australia/Sydney', SUMMER)).toBe(-600);
    expect(resolveTimezoneOffsetMinutes('Asia/Shanghai', SUMMER)).toBe(-480);
    expect(resolveTimezoneOffsetMinutes('Asia/Shanghai', WINTER)).toBe(-480);
    expect(resolveTimezoneJsDateSuffix('Asia/Shanghai', SUMMER)).toBe(
      'GMT+0800 (China Standard Time)',
    );
  });

  it('formats a zero offset the way V8 does', () => {
    expect(resolveTimezoneOffsetMinutes('Europe/London', WINTER)).toBe(0);
    expect(resolveTimezoneJsDateSuffix('Europe/London', WINTER)).toBe(
      'GMT+0000 (Greenwich Mean Time)',
    );
    expect(resolveTimezoneJsDateSuffix('Europe/London', SUMMER)).toBe(
      'GMT+0100 (British Summer Time)',
    );
  });

  it('falls back to the profile’s stored standard-time pair for an unknown zone', () => {
    const profile = generateBrowserDeviceProfile({ seed: 'timezone-fallback' });
    const broken = { ...profile, timezone: { ...profile.timezone, iana: 'Mars/Olympus_Mons' } };

    expect(resolveTimezoneOffsetMinutes('Mars/Olympus_Mons', SUMMER)).toBeUndefined();
    expect(resolveProfileTimezone(broken, SUMMER)).toEqual({
      jsDateSuffix: profile.timezone.jsDateSuffix,
      offsetMinutes: profile.timezone.offsetMinutes,
    });
  });

  /**
   * Small-ICU builds know only UTC, which would silently degrade every profile to its
   * stored standard-time pair (a contradiction for half the year). This is the guard that
   * turns that deployment mistake into a red test.
   */
  it('resolves every pooled zone on this runtime, so full ICU data is really present', () => {
    expect(BROWSER_PROFILE_TIMEZONE_POOL.length).toBeGreaterThan(0);
    for (const iana of BROWSER_PROFILE_TIMEZONE_POOL) {
      expect(resolveTimezoneOffsetMinutes(iana, SUMMER), iana).not.toBeUndefined();
      expect(resolveTimezoneOffsetMinutes(iana, WINTER), iana).not.toBeUndefined();
      expect(resolveTimezoneJsDateSuffix(iana, SUMMER), iana).toMatch(/^GMT[+-]\d{4} \(.+\)$/);
      expect(resolveTimezoneJsDateSuffix(iana, WINTER), iana).toMatch(/^GMT[+-]\d{4} \(.+\)$/);
    }
  });

  it('matches the profile’s stored offset in that zone’s standard time', () => {
    for (let index = 0; index < 60; index += 1) {
      const profile = generateBrowserDeviceProfile({ seed: `timezone-${index}` });
      const summer = resolveProfileTimezone(profile, SUMMER).offsetMinutes;
      const winter = resolveProfileTimezone(profile, WINTER).offsetMinutes;

      // One of the two halves of the year is always the stored standard offset.
      expect([summer, winter]).toContain(profile.timezone.offsetMinutes);
    }
  });
});
