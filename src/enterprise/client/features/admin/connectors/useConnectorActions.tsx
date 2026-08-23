'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';

import type {
  AdminConnectorPermissions,
  AdminConnectorPrimaryAction,
  SessionConnectorTestResult,
} from './controller';
import {
  buildConnectorUpdatePayload,
  isPersistedConnectorTestCurrent,
  resolveAdminConnectorPrimaryAction,
} from './controller';
import type { AdminConnectorGetOutput } from './types';
import { refreshAdminConnectorLists } from './useAdminConnectorCatalog';
import { useConnectorDangerActions } from './useConnectorDangerActions';
import type { useConnectorEditor } from './useConnectorEditor';
import { useConnectorMutationRunner } from './useConnectorMutationRunner';

interface UseConnectorActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminConnectorGetOutput;
  editor: ReturnType<typeof useConnectorEditor>;
  mutate: () => Promise<AdminConnectorGetOutput | undefined>;
  permissions: AdminConnectorPermissions;
}

export const useConnectorActions = ({
  authMethod,
  data,
  editor,
  mutate,
  permissions,
}: UseConnectorActionsParams) => {
  const { t } = useTranslation('admin');
  const runner = useConnectorMutationRunner({ authMethod, editor, mutate });
  const { busyAction, errorText, run, runSimple, setBusyAction } = runner;
  const { archive, deleteDraft, revokeBindings, rollback } = useConnectorDangerActions({
    authMethod,
    data,
    editor,
    permissions,
    runner,
  });
  /** Retains a successful test across refetch until draft identity changes. */
  const [sessionTest, setSessionTest] = useState<SessionConnectorTestResult | null>(null);

  useEffect(() => {
    if (!sessionTest) return;
    if (
      sessionTest.testedRevision !== data.baseRevision ||
      sessionTest.testedDraftToken !== data.draftToken
    ) {
      setSessionTest(null);
    }
  }, [data.baseRevision, data.draftToken, sessionTest]);

  const openSave = useCallback(async () => {
    if (
      !permissions.canUpdate ||
      !editor.draft ||
      !editor.dirty ||
      !editor.validation.valid ||
      editor.requiresSecretReentry
    )
      return;
    // Freeze the draft + CAS before the write so a reauth retry replays the same request.
    const payload = buildConnectorUpdatePayload({
      draft: structuredClone(editor.draft),
      secret: editor.secret,
      snapshot: data,
    });
    editor.setSaveState('saving');
    const committed = await runAdminMutation({
      authMethod,
      // `run` already mapped the failure into the editor's inline error surface.
      onError: () => editor.setSaveState('failed'),
      run: () =>
        run(
          'save',
          () => adminConnectorsService.updateDraft(payload),
          'connectorCatalog.toast.saved',
        ),
    });
    if (committed) editor.markSaved();
  }, [authMethod, data, editor, permissions.canUpdate, run]);

  const discover = useCallback(
    () =>
      runSimple({
        action: 'discover',
        operation: () => adminConnectorsService.discover({ id: data.draft.id }),
        permission: permissions.canDiscover,
        successKey: 'connectorCatalog.toast.discovered',
      }),
    [data.draft.id, permissions.canDiscover, runSimple],
  );

  const test = useCallback(async () => {
    if (!permissions.canTest || editor.dirty || editor.conflict || busyAction) return;
    const testedRevision = data.baseRevision;
    const testedDraftToken = data.draftToken;
    setBusyAction('test');
    editor.setActionError(null);
    try {
      await runAdminMutation({
        authMethod,
        onError: (cause) => {
          setSessionTest(null);
          const mapped = mapEnterpriseError(cause);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') editor.setConflict(true);
          editor.setActionError(errorText(cause));
        },
        run: async () => {
          const result = await adminConnectorsService.test({ id: data.draft.id });
          if (result.status === 'success') {
            setSessionTest({
              status: 'success',
              testedDraftToken,
              testedRevision,
            });
            toast.success(t('connectorCatalog.toast.tested'));
          } else {
            setSessionTest(null);
            editor.setActionError(t('connectorCatalog.errors.generic'));
          }
          await Promise.allSettled([mutate(), refreshAdminConnectorLists()]);
        },
      });
    } finally {
      setBusyAction(null);
    }
  }, [
    authMethod,
    busyAction,
    data.baseRevision,
    data.draft.id,
    data.draftToken,
    editor,
    errorText,
    mutate,
    permissions.canTest,
    setBusyAction,
    t,
  ]);

  const publish = useCallback(
    () =>
      runSimple({
        action: 'publish',
        operation: () =>
          adminConnectorsService.publish({
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
            id: data.draft.id,
          }),
        permission: permissions.canPublish && isPersistedConnectorTestCurrent(data, sessionTest),
        successKey: 'connectorCatalog.toast.published',
      }),
    [data, permissions.canPublish, runSimple, sessionTest],
  );

  const primaryAction = resolveAdminConnectorPrimaryAction({
    canPublish: permissions.canPublish && data.draft.status !== 'archived',
    canSave: permissions.canUpdate && editor.validation.valid && !editor.requiresSecretReentry,
    canTest: permissions.canTest && data.draft.status !== 'archived',
    conflict: editor.conflict,
    dirty: editor.dirty,
    saveFailed: editor.saveState === 'failed',
    testPassed: isPersistedConnectorTestCurrent(data, sessionTest),
  });

  const onPrimaryAction = useCallback(
    (action: AdminConnectorPrimaryAction) => {
      if (action === 'save' || action === 'retry') void openSave();
      else if (action === 'test') void test();
      else if (action === 'publish') void publish();
    },
    [openSave, publish, test],
  );

  return {
    archive,
    busyAction,
    deleteDraft,
    discover,
    onPrimaryAction,
    primaryAction,
    revokeBindings,
    rollback,
  };
};
