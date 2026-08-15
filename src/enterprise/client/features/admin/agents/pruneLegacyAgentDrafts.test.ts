// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneLegacyAdminAgentDrafts } from './pruneLegacyAgentDrafts';

describe('pruneLegacyAdminAgentDrafts', () => {
  beforeEach(() => localStorage.clear());

  it('drops every legacy Agent recovery draft and leaves other storage alone', () => {
    localStorage.setItem('aihub.admin.agents.draft.agent-1', '{"draft":{}}');
    localStorage.setItem('aihub.admin.agents.draft.agent-2', '{"draft":{}}');
    localStorage.setItem('aihub.admin.settings.draft:appearance', '{}');
    localStorage.setItem('unrelated', 'keep');

    pruneLegacyAdminAgentDrafts();

    expect(localStorage.getItem('aihub.admin.agents.draft.agent-1')).toBeNull();
    expect(localStorage.getItem('aihub.admin.agents.draft.agent-2')).toBeNull();
    // The settings editor owns its own prune — never reach across domains.
    expect(localStorage.getItem('aihub.admin.settings.draft:appearance')).toBe('{}');
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('never throws when storage is unavailable (private mode / quota)', () => {
    const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => pruneLegacyAdminAgentDrafts()).not.toThrow();
    spy.mockRestore();
  });
});
