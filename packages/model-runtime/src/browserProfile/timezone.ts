import type { BrowserDeviceProfile, BrowserTimezoneProfile } from './types';

/**
 * The stored profile keeps the zone's STANDARD offset (`offsetKind: 'standard'`), but a
 * real browser reports the offset in force right now: a profile on `America/New_York`
 * says `-240` / "Eastern Daylight Time" in August and `-300` / "Eastern Standard Time"
 * in January. Sending the IANA name and the standard offset in the same payload
 * contradicts itself for half the year in half the pooled zones, so both are recomputed
 * per request from the zone name through `Intl` — host-independent, the host clock only
 * supplies "now".
 *
 * ICU DEPENDENCY (accepted, pinned by test): the offset and the long zone name come from
 * the runtime's tzdata/CLDR, so a Node/ICU upgrade can change a label (or an offset, when
 * a country changes its rules) and a SMALL-ICU build knows no zone at all and silently
 * falls back to the stored standard-time pair. Deployments therefore run the project's
 * pinned full-ICU Node image; `timezone.test.ts` resolves every pooled zone on the
 * running runtime so a small-ICU environment fails the suite instead of production.
 */

/** `GMT`, `GMT+08:00`, `GMT-03:30`. */
const LONG_OFFSET_RE = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/;

const timeZoneNamePart = (
  iana: string,
  at: Date,
  timeZoneName: 'long' | 'longOffset',
  locale = 'en-US',
): string | undefined =>
  new Intl.DateTimeFormat(locale, { timeZone: iana, timeZoneName })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;

/**
 * `Date#getTimezoneOffset()` convention: minutes WEST of UTC, so `Asia/Shanghai` is
 * `-480`. Returns `undefined` when the zone is unknown to this runtime.
 */
export const resolveTimezoneOffsetMinutes = (iana: string, at: Date = new Date()) => {
  try {
    const longOffset = timeZoneNamePart(iana, at, 'longOffset');
    const match = longOffset ? LONG_OFFSET_RE.exec(longOffset) : undefined;
    if (!match) return undefined;
    if (!match[1]) return 0;
    const minutesEast = Number(match[2]) * 60 + Number(match[3]);
    // `|| 0` keeps a zero offset positive: `Date#getTimezoneOffset()` never returns -0.
    return (match[1] === '+' ? -minutesEast : minutesEast) || 0;
  } catch {
    return undefined;
  }
};

const formatOffsetToken = (offsetMinutes: number): string => {
  const minutesEast = -offsetMinutes;
  const sign = minutesEast < 0 ? '-' : '+';
  const absolute = Math.abs(minutesEast);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `GMT${sign}${hours}${minutes}`;
};

/**
 * The `Date#toString()` tail V8 produces for this zone right now, for example
 * `GMT+0100 (Central European Summer Time)`.
 */
export const resolveTimezoneJsDateSuffix = (
  iana: string,
  at: Date = new Date(),
  locale = 'en-US',
) => {
  try {
    const longName = timeZoneNamePart(iana, at, 'long', locale);
    const offsetMinutes = resolveTimezoneOffsetMinutes(iana, at);
    if (!longName || offsetMinutes === undefined) return undefined;
    return `${formatOffsetToken(offsetMinutes)} (${longName})`;
  } catch {
    return undefined;
  }
};

/**
 * Live timezone facts for one request. Falls back to the profile's stored standard-time
 * values when the runtime does not know the zone (`Intl` without full ICU data).
 */
export const resolveProfileTimezone = (
  profile: Pick<BrowserDeviceProfile, 'timezone'> &
    Partial<Pick<BrowserDeviceProfile, 'languages' | 'oaiLanguage'>>,
  at: Date = new Date(),
): Pick<BrowserTimezoneProfile, 'jsDateSuffix' | 'offsetMinutes'> => {
  const { iana, jsDateSuffix, offsetMinutes } = profile.timezone;
  const locale = profile.languages?.[0] ?? profile.oaiLanguage ?? 'en-US';
  return {
    jsDateSuffix: resolveTimezoneJsDateSuffix(iana, at, locale) ?? jsDateSuffix,
    offsetMinutes: resolveTimezoneOffsetMinutes(iana, at) ?? offsetMinutes,
  };
};
