// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSkillGetOutput } from '../types';
import { useSkillActions } from './useSkillActions';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  createVersion: vi.fn(),
  openReasonModal: vi.fn(),
  openVersionEditorModal: vi.fn(),
  publish: vi.fn(),
  refresh: vi.fn(),
  rollback: vi.fn(),
  updateDraft: vi.fn(),
  validate: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { success: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (error: { code?: string }) =>
    error?.code
      ? { action: 'retry', code: error.code, i18nKey: `enterprise.error.${error.code}` }
      : null,
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: {
    archive: mocks.archive,
    createVersion: mocks.createVersion,
    publish: mocks.publish,
    rollback: mocks.rollback,
    updateDraft: mocks.updateDraft,
    validate: mocks.validate,
  },
}));
vi.mock('../openVersionEditorModal', () => ({
  createInitialSkillVersionDraft: () => ({
    content: '',
    contentRef: '',
    manifestText: '{}',
    resourcesText: '[]',
    version: '1.0.0',
  }),
  openVersionEditorModal: mocks.openVersionEditorModal,
}));
vi.mock('./useAdminSkills', () => ({ refreshAdminSkill: mocks.refresh }));

const data = (id = 'skill-1', revision = 3): AdminSkillGetOutput => ({
  baseRevision: revision,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: 'version-1',
    description: 'Server description',
    displayName: id,
    distribution: 'default',
    draftSequence: revision,
    enabled: true,
    id,
    revision,
    skillKey: id,
    source: 'uploaded',
    status: 'draft',
  },
  draftToken: String(revision).repeat(64),
  latestVersion: null,
  publishedVersion: null,
});

const editor = () => ({
  actionError: null,
  baseDraft: {
    identity: {
      description: 'Server description',
      displayName: 'skill-1',
      distribution: 'default' as const,
      enabled: true,
    },
    versionDraft: null,
  },
  conflict: false,
  dirty: true,
  draft: {
    identity: {
      description: 'Local description',
      displayName: 'skill-1',
      distribution: 'default' as const,
      enabled: true,
    },
    versionDraft: null,
  },
  markSaved: vi.fn(),
  markVersionSaved: vi.fn(),
  setActionError: vi.fn(),
  setConflict: vi.fn(),
  setSaveState: vi.fn(),
  updateVersionDraft: vi.fn(),
});

const permissions = {
  canArchive: true,
  canCreate: true,
  canPublish: true,
  canRead: true,
  canUpdate: true,
};

const validation = {
  issues: [],
  validatedAt: new Date(0),
  validatorVersion: 'v1',
};

describe('M08 Skill write actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.archive.mockResolvedValue({});
    mocks.publish.mockResolvedValue({});
    mocks.refresh.mockResolvedValue(data('skill-1', 4));
    mocks.rollback.mockResolvedValue({});
    mocks.updateDraft.mockResolvedValue({});
    mocks.validate.mockResolvedValue(validation);
  });

  it('keeps the modal-open publish snapshot across same-resource SWR drift and reauth retry', async () => {
    const currentEditor = { ...editor(), dirty: false };
    const { rerender, result } = renderHook(
      ({ snapshot }) =>
        useSkillActions({
          authMethod: 'oidc',
          data: snapshot,
          editor: currentEditor as any,
          permissions,
          selectedValidation: validation,
          selectedVersionId: 'version-1',
        }),
      { initialProps: { snapshot: data() } },
    );
    act(() => result.current.openPublish());
    const modal = mocks.openReasonModal.mock.calls[0][0];
    expect(modal.authMethod).toBe('oidc');
    const frozen = modal.buildPayload('approved');

    rerender({ snapshot: data('skill-1', 9) });
    await act(() => modal.onSubmit(structuredClone(frozen)));
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftToken: '3'.repeat(64),
        expectedRevision: 3,
        id: 'skill-1',
        reason: 'approved',
        versionId: 'version-1',
      }),
    );
  });

  it('rejects an old modal after the hook switches resources', async () => {
    const currentEditor = { ...editor(), dirty: false };
    const { rerender, result } = renderHook(
      ({ snapshot }) =>
        useSkillActions({
          authMethod: null,
          data: snapshot,
          editor: currentEditor as any,
          permissions,
          selectedValidation: validation,
          selectedVersionId: 'version-1',
        }),
      { initialProps: { snapshot: data() } },
    );
    act(() => result.current.openArchive());
    const modal = mocks.openReasonModal.mock.calls[0][0];
    const frozen = modal.buildPayload('archive');
    rerender({ snapshot: data('skill-2', 1) });
    await expect(modal.onSubmit(frozen)).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('preserves the local draft and enters explicit conflict mode after failed save', async () => {
    const currentEditor = editor();
    const conflict = Object.assign(new Error('conflict'), { code: 'PLATFORM_REVISION_CONFLICT' });
    mocks.updateDraft.mockRejectedValueOnce(conflict);
    const { result } = renderHook(() =>
      useSkillActions({
        authMethod: null,
        data: data(),
        editor: currentEditor as any,
        permissions,
        selectedValidation: null,
      }),
    );
    act(() => result.current.openSaveIdentity());
    const modal = mocks.openReasonModal.mock.calls[0][0];
    const frozen = modal.buildPayload('save it');
    await expect(modal.onSubmit(frozen)).rejects.toBe(conflict);
    expect(currentEditor.draft.identity.description).toBe('Local description');
    expect(currentEditor.markSaved).not.toHaveBeenCalled();
    expect(currentEditor.setConflict).toHaveBeenCalledWith(true);
    expect(currentEditor.setSaveState).toHaveBeenLastCalledWith('failed');
    expect(mocks.refresh).toHaveBeenCalledWith('skill-1');
    expect(result.current.actionLoading).toBeNull();
  });

  it('does not open write modals for a read-only permission set', () => {
    const currentEditor = editor();
    const { result } = renderHook(() =>
      useSkillActions({
        authMethod: null,
        data: data(),
        editor: currentEditor as any,
        permissions: { ...permissions, canArchive: false, canPublish: false, canUpdate: false },
        selectedValidation: validation,
        selectedVersionId: 'version-1',
      }),
    );
    act(() => {
      result.current.openSaveIdentity();
      result.current.openCreateVersion();
      result.current.openValidate();
      result.current.openPublish();
      result.current.openRollback('version-1');
      result.current.openArchive();
    });
    expect(mocks.openReasonModal).not.toHaveBeenCalled();
    expect(mocks.openVersionEditorModal).not.toHaveBeenCalled();
  });
});
