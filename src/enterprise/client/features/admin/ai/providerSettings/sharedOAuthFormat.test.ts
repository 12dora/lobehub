import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { buildAdminSharedOAuthStatusKey, formatExpiry } from './sharedOAuthFormat';

describe('formatExpiry', () => {
  it('renders one explicit shape rather than following the OS locale', () => {
    const at = dayjs('2026-10-17 19:08:29');

    expect(formatExpiry(String(at.valueOf()))).toBe('2026/10/17 19:08:29');
  });

  it('does not pad the month or the day', () => {
    // The card puts two of these on one line; zero-padding would make the halves disagree.
    const at = dayjs('2026-08-18 09:08:30');

    expect(formatExpiry(String(at.valueOf()))).toBe('2026/8/18 09:08:30');
  });

  it('treats anything unparsable as unknown, so no row is rendered', () => {
    expect(formatExpiry(null)).toBeUndefined();
    expect(formatExpiry('')).toBeUndefined();
    expect(formatExpiry('not-a-number')).toBeUndefined();
    expect(formatExpiry('0')).toBeUndefined();
    expect(formatExpiry('-1')).toBeUndefined();
  });
});

describe('buildAdminSharedOAuthStatusKey', () => {
  it('scopes the status cache to one provider', () => {
    expect(buildAdminSharedOAuthStatusKey('supergrok')).toEqual([
      'admin.aiProviderOAuth.getConnectionStatus',
      'supergrok',
    ]);
  });
});
