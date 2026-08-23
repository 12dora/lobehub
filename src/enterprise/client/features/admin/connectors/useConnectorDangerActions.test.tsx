// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminConnectorPermissions } from './controller';
import type { AdminConnectorGetOutput } from './types';
import { useConnectorDangerActions } from './useConnectorDangerActions';
import type { useConnectorEditor } from './useConnectorEditor';
import type { ConnectorMutationRunner } from './useConnectorMutationRunner';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openDangerConfirm: vi.fn(),
  openReasonModal: vi.fn(),
  t: vi.fn((key: string) => key),
}));

vi.mock('react-router', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/enterprise/client/features/admin/primitives/DangerConfirm', () => ({
  openDangerConfirm: mocks.openDangerConfirm,
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: {
    archive: vi.fn(),
    deleteDraft: vi.fn(),
    revokeAllBindings: vi.fn(),
    rollback: vi.fn(),
  },
}));

vi.mock('./useAdminConnectorCatalog', () => ({
  refreshAdminConnectorLists: vi.fn(async () => {}),
}));

/** Unpublished draft: the only state where `deleteDraft` is offered at all. */
const draftSnapshot = (): AdminConnectorGetOutput =>
  ({
    baseRevision: 3,
    draft: { displayName: 'Calendar', id: 'connector-1', revision: 3, status: 'draft' },
    draftToken: 'c'.repeat(64),
    published: null,
  }) as unknown as AdminConnectorGetOutput;

const permissions = (): AdminConnectorPermissions => ({
  canArchive: true,
  canCreate: true,
  canDelete: true,
  canDiscover: true,
  canPublish: true,
  canRead: true,
  canReadAudit: true,
  canRevokeBindings: true,
  canTest: true,
  canUpdate: true,
});

const idleEditor = () =>
  ({
    conflict: false,
    dirty: false,
    setActionError: vi.fn(),
    setConflict: vi.fn(),
  }) as unknown as ReturnType<typeof useConnectorEditor>;

const runner = (busyAction: string | null): ConnectorMutationRunner =>
  ({
    busyAction,
    errorText: vi.fn(() => 'error'),
    run: vi.fn(async () => {}),
    runSimple: vi.fn(async () => {}),
    setBusyAction: vi.fn(),
  }) as unknown as ConnectorMutationRunner;

const renderDangerActions = (busyAction: string | null) =>
  renderHook(() =>
    useConnectorDangerActions({
      authMethod: null,
      data: draftSnapshot(),
      editor: idleEditor(),
      permissions: permissions(),
      runner: runner(busyAction),
    }),
  );

describe('useConnectorDangerActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delete_draft_refuses_while_another_mutation_holds_the_busy_slot', () => {
    const { result } = renderDangerActions('save');

    result.current.deleteDraft();

    // The single busy slot is shared: starting a delete mid-flight would overwrite
    // whatever the in-flight mutation set. `archive` / `rollback` / `revokeBindings`
    // already refuse here.
    expect(mocks.openReasonModal).not.toHaveBeenCalled();
  });

  it('destructive_actions_all_refuse_while_busy', () => {
    const { result } = renderDangerActions('save');

    result.current.archive();
    result.current.rollback();
    result.current.revokeBindings();

    expect(mocks.openDangerConfirm).not.toHaveBeenCalled();
    expect(mocks.openReasonModal).not.toHaveBeenCalled();
  });

  it('delete_draft_still_opens_its_confirmation_when_idle', () => {
    const { result } = renderDangerActions(null);

    result.current.deleteDraft();

    expect(mocks.openReasonModal).toHaveBeenCalledTimes(1);
  });
});
