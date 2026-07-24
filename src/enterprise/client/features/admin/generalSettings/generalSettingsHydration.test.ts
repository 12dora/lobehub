// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  decideGeneralSettingsHydration,
  fingerprintGeneralSettingsDraft,
} from './generalSettingsHydration';

const snap = (override: Partial<Parameters<typeof fingerprintGeneralSettingsDraft>[0]> = {}) => ({
  emailDomainAllowlistEnabled: false,
  emailDomainText: '',
  openRegistration: true,
  ...override,
});

describe('decideGeneralSettingsHydration', () => {
  it('accepts the first server snapshot when local state is empty', () => {
    const next = snap({ openRegistration: false });
    expect(
      decideGeneralSettingsHydration({
        baselineFp: null,
        draftFp: null,
        next,
        saving: false,
      }),
    ).toEqual({ action: 'accept', next });
  });

  it('ignores identity churn when the server fingerprint matches the baseline', () => {
    const baseline = snap();
    const fp = fingerprintGeneralSettingsDraft(baseline);
    expect(
      decideGeneralSettingsHydration({
        baselineFp: fp,
        draftFp: fp,
        next: { ...baseline },
        saving: false,
      }),
    ).toEqual({ action: 'keep', markStale: false });
  });

  it('accepts a new server snapshot when the local draft is clean', () => {
    const baseline = snap();
    const next = snap({ openRegistration: false, emailDomainAllowlistEnabled: true });
    expect(
      decideGeneralSettingsHydration({
        baselineFp: fingerprintGeneralSettingsDraft(baseline),
        draftFp: fingerprintGeneralSettingsDraft(baseline),
        next,
        saving: false,
      }),
    ).toEqual({ action: 'accept', next });
  });

  it('retains a dirty draft and marks stale when the server advances', () => {
    const baseline = snap();
    const dirty = snap({ openRegistration: false });
    const next = snap({
      emailDomainAllowlistEnabled: true,
      emailDomainText: 'example.com',
      openRegistration: true,
    });
    expect(
      decideGeneralSettingsHydration({
        baselineFp: fingerprintGeneralSettingsDraft(baseline),
        draftFp: fingerprintGeneralSettingsDraft(dirty),
        next,
        saving: false,
      }),
    ).toEqual({ action: 'keep', markStale: true });
  });

  it('does not auto-accept while saving even if draft matches baseline', () => {
    const baseline = snap();
    const next = snap({ openRegistration: false });
    // While saving, treat as dirty-path protection against racing revalidate.
    expect(
      decideGeneralSettingsHydration({
        baselineFp: fingerprintGeneralSettingsDraft(baseline),
        draftFp: fingerprintGeneralSettingsDraft(baseline),
        next,
        saving: true,
      }),
    ).toEqual({ action: 'keep', markStale: true });
  });
});
