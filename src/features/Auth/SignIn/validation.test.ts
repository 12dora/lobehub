import { describe, expect, it } from 'vitest';

import { shouldShowLocalEmailForm } from './validation';

describe('sign-in path visibility', () => {
  it('retains the local break-glass path when a database provider is configured', () => {
    expect(
      shouldShowLocalEmailForm({
        disableEmailPassword: true,
        hasConfiguredDatabaseProvider: true,
        isSocialOnly: false,
      }),
    ).toBe(true);
  });

  it('does not override a user-specific social-only state', () => {
    expect(
      shouldShowLocalEmailForm({
        disableEmailPassword: false,
        hasConfiguredDatabaseProvider: true,
        isSocialOnly: true,
      }),
    ).toBe(false);
  });
});
