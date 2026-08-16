// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneLegacyBrandingDrafts } from './pruneLegacyBrandingDrafts';

describe('pruneLegacyBrandingDrafts', () => {
  beforeEach(() => localStorage.clear());

  it('drops every legacy branding recovery draft and leaves other storage alone', () => {
    localStorage.setItem('aihub.admin.branding.draft:r1', '{"draft":{}}');
    localStorage.setItem('aihub.admin.branding.draft:r2', '{"draft":{}}');
    localStorage.setItem('aihub.admin.settings.draft:appearance', '{}');
    localStorage.setItem('unrelated', 'keep');

    pruneLegacyBrandingDrafts();

    expect(localStorage.getItem('aihub.admin.branding.draft:r1')).toBeNull();
    expect(localStorage.getItem('aihub.admin.branding.draft:r2')).toBeNull();
    // The settings editor owns its own prune — never reach across domains.
    expect(localStorage.getItem('aihub.admin.settings.draft:appearance')).toBe('{}');
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('never throws when storage is unavailable (private mode / quota)', () => {
    const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => pruneLegacyBrandingDrafts()).not.toThrow();
    spy.mockRestore();
  });
});
