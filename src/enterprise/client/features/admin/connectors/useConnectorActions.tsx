'use client';

import { Flexbox, InputNumber, Text } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { openDangerConfirm } from '@/enterprise/client/features/admin/primitives/DangerConfirm';
import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
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
  validateConnectorRollbackTarget,
} from './controller';
import type { AdminConnectorGetOutput, AdminConnectorRollbackInput } from './types';
import { refreshAdminConnectorLists } from './useAdminConnectorCatalog';
import type { useConnectorEditor } from './useConnectorEditor';

interface UseConnectorActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminConnectorGetOutput;
  editor: ReturnType<typeof useConnectorEditor>;
  mutate: () => Promise<AdminConnectorGetOutput | undefined>;
  permissions: AdminConnectorPermissions;
}

/**
 * Stable, non-localized audit reason for rollback. The confirmation stays because it also
 * collects the target revision, but the operator no longer types a reason.
 */
const ROLLBACK_REASON = 'Connector rolled back from admin console';

const RollbackRevisionField = ({
  currentRevision,
  disabled,
  onChange,
}: {
  currentRevision: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) => {
  const { t } = useTranslation('admin');
  const [value, setValue] = useState<number | null>(null);

  return (
    <Flexbox gap={6}>
      <Text strong>{t('connectorCatalog.mutations.rollback.target')}</Text>
      <InputNumber
        disabled={disabled}
        min={1}
        precision={0}
        value={value}
        onChange={(next) => {
          const revision = typeof next === 'number' ? next : null;
          setValue(revision);
          onChange(revision);
        }}
      />
      <Text type="secondary">
        {t('connectorCatalog.mutations.rollback.current', { revision: currentRevision })}
      </Text>
    </Flexbox>
  );
};

export const useConnectorActions = ({
  authMethod,
  data,
  editor,
  mutate,
  permissions,
}: UseConnectorActionsParams) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [busyAction, setBusyAction] = useState<string | null>(null);
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

  const errorText = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      return mapped
        ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
        : t('connectorCatalog.errors.generic');
    },
    [t],
  );

  const run = useCallback(
    async (action: string, operation: () => Promise<unknown>, successKey: string) => {
      setBusyAction(action);
      editor.setActionError(null);
      try {
        // Mutation commit is authoritative. Cache revalidation failures must not
        // reclassify a successful server write as a failed action (false conflict
        // on retry / stuck editor revision).
        await operation();
        toast.success(t(successKey as never));
        await Promise.allSettled([mutate(), refreshAdminConnectorLists()]);
      } catch (cause) {
        const mapped = mapEnterpriseError(cause);
        if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') editor.setConflict(true);
        editor.setActionError(errorText(cause));
        throw cause;
      } finally {
        setBusyAction(null);
      }
    },
    [editor, errorText, mutate, t],
  );

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

  /** Reason-less catalog action: no prompt, optional confirmation, shared error/refresh path. */
  const runSimple = useCallback(
    async (params: {
      action: string;
      operation: () => Promise<unknown>;
      permission: boolean;
      successKey: string;
    }) => {
      if (!params.permission || editor.dirty || editor.conflict || busyAction) return;
      await runAdminMutation({
        authMethod,
        // `run` already mapped the failure into the editor's inline error surface.
        onError: () => undefined,
        run: () => run(params.action, params.operation, params.successKey),
      });
    },
    [authMethod, busyAction, editor.conflict, editor.dirty, run],
  );

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

  const archive = useCallback(() => {
    if (!permissions.canArchive || editor.dirty || editor.conflict || busyAction) return;
    openDangerConfirm({
      confirmText: t('connectorCatalog.actions.archive'),
      content: t('connectorCatalog.mutations.archive.description'),
      title: t('connectorCatalog.mutations.archive.title'),
      onConfirm: () =>
        runSimple({
          action: 'archive',
          operation: () =>
            adminConnectorsService.archive({
              expectedDraftToken: data.draftToken,
              expectedRevision: data.baseRevision,
              id: data.draft.id,
            }),
          permission: permissions.canArchive,
          successKey: 'connectorCatalog.toast.archived',
        }),
    });
  }, [busyAction, data, editor.conflict, editor.dirty, permissions.canArchive, runSimple, t]);

  /**
   * Revoking every user's connection is destructive and irreversible for them — this is one of
   * the few actions that still requires the operator to record an audit reason.
   */
  const revokeBindings = useCallback(() => {
    if (
      !permissions.canRevokeBindings ||
      !data.published ||
      editor.dirty ||
      editor.conflict ||
      busyAction
    ) {
      return;
    }
    const publishedRevision = data.published.publishedRevision;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ reason }),
      danger: true,
      description: t('connectorCatalog.mutations.revoke.description'),
      onSubmit: async (input) => {
        await run(
          'revoke',
          () =>
            adminConnectorsService.revokeAllBindings({
              expectedRevision: publishedRevision,
              id: data.draft.id,
              reason: (input as { reason: string }).reason,
            }),
          'connectorCatalog.toast.revoked',
        );
      },
      submitLabel: t('connectorCatalog.actions.revokeBindings'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.revoke.title'),
    });
  }, [
    authMethod,
    busyAction,
    data.draft.displayName,
    data.draft.id,
    data.published,
    editor.conflict,
    editor.dirty,
    permissions.canRevokeBindings,
    run,
    t,
  ]);

  const rollback = useCallback(() => {
    const currentRevision = data.published?.publishedRevision;
    if (
      !permissions.canPublish ||
      !currentRevision ||
      editor.dirty ||
      editor.conflict ||
      busyAction
    ) {
      return;
    }
    const targetRevisionRef: { current: number | null } = { current: null };
    openReasonModal({
      authMethod: authMethod ?? undefined,
      autoReason: ROLLBACK_REASON,
      buildPayload: (reason) => ({
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        reason,
        targetRevision: targetRevisionRef.current,
      }),
      danger: true,
      description: t('connectorCatalog.mutations.rollback.description'),
      hideReason: true,
      extra: ({ locked }) => (
        <RollbackRevisionField
          currentRevision={currentRevision}
          disabled={locked}
          onChange={(value) => {
            targetRevisionRef.current = value;
          }}
        />
      ),
      onSubmit: async (input) => {
        await run(
          'rollback',
          () => adminConnectorsService.rollback(input as AdminConnectorRollbackInput),
          'connectorCatalog.toast.rolledBack',
        );
      },
      submitLabel: t('connectorCatalog.actions.rollback'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.rollback.title'),
      validateExtra: () => {
        const error = validateConnectorRollbackTarget(targetRevisionRef.current, currentRevision);
        return error ? `connectorCatalog.mutations.rollback.validation.${error}` : null;
      },
    });
  }, [authMethod, busyAction, data, editor.conflict, editor.dirty, permissions.canPublish, run, t]);

  const deleteDraft = useCallback(() => {
    if (!permissions.canDelete || data.published || editor.dirty || editor.conflict) return;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ id: data.draft.id, reason }),
      danger: true,
      description: t('connectorCatalog.mutations.delete.description'),
      onSubmit: async (input) => {
        setBusyAction('delete');
        try {
          await adminConnectorsService.deleteDraft({
            ...(input as { id: string; reason: string }),
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
          });
          // Delete committed: navigate and toast even if list revalidation fails.
          toast.success(t('connectorCatalog.toast.deleted'));
          navigate('/admin/connectors');
          await Promise.allSettled([refreshAdminConnectorLists()]);
        } catch (cause) {
          editor.setActionError(errorText(cause));
          throw cause;
        } finally {
          setBusyAction(null);
        }
      },
      submitLabel: t('connectorCatalog.actions.deleteDraft'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.delete.title'),
    });
  }, [authMethod, data, editor, errorText, navigate, permissions.canDelete, t]);

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
