import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { normalizeAssignmentDraft, validateAssignmentDraft } from './useAssignmentEditor';

describe('assignment draft normalization + validation', () => {
  it('normalizes a global target to the sentinel and clears pinned version for latest policy', () => {
    const draft = normalizeAssignmentDraft({
      enabled: true,
      mode: 'optional',
      pinnedVersionId: 'version-1',
      targetId: 'ignored',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    expect(draft).toEqual({
      enabled: true,
      mode: 'optional',
      pinnedVersionId: null,
      targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    expect(validateAssignmentDraft(draft)).toBeNull();
  });

  it('trims a non-global target id and keeps the pinned version when pinned', () => {
    const draft = normalizeAssignmentDraft({
      enabled: false,
      mode: 'mandatory',
      pinnedVersionId: 'version-9',
      targetId: '  role-admins  ',
      targetType: 'global_role',
      versionPolicy: 'pinned',
    });
    expect(draft.targetId).toBe('role-admins');
    expect(draft.pinnedVersionId).toBe('version-9');
    expect(validateAssignmentDraft(draft)).toBeNull();
  });

  it('flags a missing target id and a missing pinned version', () => {
    expect(
      validateAssignmentDraft(
        normalizeAssignmentDraft({
          enabled: true,
          mode: 'optional',
          pinnedVersionId: null,
          targetId: '   ',
          targetType: 'user',
          versionPolicy: 'latest_published',
        }),
      ),
    ).toBe('agentCatalog.assignment.errors.targetRequired');

    expect(
      validateAssignmentDraft(
        normalizeAssignmentDraft({
          enabled: true,
          mode: 'optional',
          pinnedVersionId: null,
          targetId: 'user-1',
          targetType: 'user',
          versionPolicy: 'pinned',
        }),
      ),
    ).toBe('agentCatalog.assignment.errors.versionRequired');
  });
});
