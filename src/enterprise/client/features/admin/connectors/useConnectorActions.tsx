'use client';

import { Flexbox, InputNumber, Text } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
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
import type {
  AdminConnectorGetOutput,
  AdminConnectorRollbackInput,
  AdminConnectorUpdateDraftInput,
} from './types';
import { refreshAdminConnectorLists } from './useAdminConnectorCatalog';
import type { useConnectorEditor } from './useConnectorEditor';

interface UseConnectorActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminConnectorGetOutput;
  editor: ReturnType<typeof useConnectorEditor>;
  mutate: () => Promise<AdminConnectorGetOutput | undefined>;
  permissions: AdminConnectorPermissions;
}

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

  const openSave = useCallback(() => {
    if (
      !permissions.canUpdate ||
      !editor.draft ||
      !editor.dirty ||
      !editor.validation.valid ||
      editor.requiresSecretReentry
    )
      return;
    const draft = structuredClone(editor.draft);
    const secret = editor.secret;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) =>
        buildConnectorUpdatePayload({ draft, reason, secret, snapshot: data }),
      description: t('connectorCatalog.mutations.save.description'),
      onSubmit: async (input) => {
        editor.setSaveState('saving');
        try {
          await run(
            'save',
            () => adminConnectorsService.updateDraft(input as AdminConnectorUpdateDraftInput),
            'connectorCatalog.toast.saved',
          );
          editor.markSaved();
        } catch (cause) {
          editor.setSaveState('failed');
          throw cause;
        }
      },
      submitLabel: t('connectorCatalog.actions.save'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.save.title'),
    });
  }, [authMethod, data, editor, permissions.canUpdate, run, t]);

  const openSimple = useCallback(
    (params: {
      action: string;
      danger?: boolean;
      descriptionKey: string;
      operation: (reason: string) => Promise<unknown>;
      permission: boolean;
      submitKey: string;
      successKey: string;
      titleKey: string;
    }) => {
      if (!params.permission || editor.dirty || editor.conflict || busyAction) return;
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({ reason }),
        danger: params.danger,
        description: t(params.descriptionKey as never),
        onSubmit: async (input) => {
          const reason = (input as { reason: string }).reason;
          await run(params.action, () => params.operation(reason), params.successKey);
        },
        submitLabel: t(params.submitKey as never),
        targetLabel: data.draft.displayName,
        title: t(params.titleKey as never),
      });
    },
    [authMethod, busyAction, data.draft.displayName, editor.conflict, editor.dirty, run, t],
  );

  const discover = useCallback(
    () =>
      openSimple({
        action: 'discover',
        descriptionKey: 'connectorCatalog.mutations.discover.description',
        operation: (reason) => adminConnectorsService.discover({ id: data.draft.id, reason }),
        permission: permissions.canDiscover,
        submitKey: 'connectorCatalog.actions.discover',
        successKey: 'connectorCatalog.toast.discovered',
        titleKey: 'connectorCatalog.mutations.discover.title',
      }),
    [data.draft.id, openSimple, permissions.canDiscover],
  );

  const test = useCallback(() => {
    if (!permissions.canTest || editor.dirty || editor.conflict || busyAction) return;
    const testedRevision = data.baseRevision;
    const testedDraftToken = data.draftToken;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({ reason }),
      description: t('connectorCatalog.mutations.test.description'),
      onSubmit: async (input) => {
        const reason = (input as { reason: string }).reason;
        setBusyAction('test');
        editor.setActionError(null);
        try {
          const result = await adminConnectorsService.test({ id: data.draft.id, reason });
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
        } catch (cause) {
          setSessionTest(null);
          const mapped = mapEnterpriseError(cause);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') editor.setConflict(true);
          editor.setActionError(errorText(cause));
          throw cause;
        } finally {
          setBusyAction(null);
        }
      },
      submitLabel: t('connectorCatalog.actions.test'),
      targetLabel: data.draft.displayName,
      title: t('connectorCatalog.mutations.test.title'),
    });
  }, [
    authMethod,
    busyAction,
    data.baseRevision,
    data.draft.displayName,
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
      openSimple({
        action: 'publish',
        descriptionKey: 'connectorCatalog.mutations.publish.description',
        operation: (reason) =>
          adminConnectorsService.publish({
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
            id: data.draft.id,
            reason,
          }),
        permission: permissions.canPublish && isPersistedConnectorTestCurrent(data, sessionTest),
        submitKey: 'connectorCatalog.actions.publish',
        successKey: 'connectorCatalog.toast.published',
        titleKey: 'connectorCatalog.mutations.publish.title',
      }),
    [data, openSimple, permissions.canPublish, sessionTest],
  );

  const archive = useCallback(
    () =>
      openSimple({
        action: 'archive',
        danger: true,
        descriptionKey: 'connectorCatalog.mutations.archive.description',
        operation: (reason) =>
          adminConnectorsService.archive({
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
            id: data.draft.id,
            reason,
          }),
        permission: permissions.canArchive,
        submitKey: 'connectorCatalog.actions.archive',
        successKey: 'connectorCatalog.toast.archived',
        titleKey: 'connectorCatalog.mutations.archive.title',
      }),
    [data, openSimple, permissions.canArchive],
  );

  const revokeBindings = useCallback(
    () =>
      openSimple({
        action: 'revoke',
        danger: true,
        descriptionKey: 'connectorCatalog.mutations.revoke.description',
        operation: (reason) =>
          adminConnectorsService.revokeAllBindings({
            expectedRevision: data.published!.publishedRevision,
            id: data.draft.id,
            reason,
          }),
        permission: permissions.canRevokeBindings && Boolean(data.published),
        submitKey: 'connectorCatalog.actions.revokeBindings',
        successKey: 'connectorCatalog.toast.revoked',
        titleKey: 'connectorCatalog.mutations.revoke.title',
      }),
    [data.draft.id, data.published, openSimple, permissions.canRevokeBindings],
  );

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
      buildPayload: (reason) => ({
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        reason,
        targetRevision: targetRevisionRef.current,
      }),
      danger: true,
      description: t('connectorCatalog.mutations.rollback.description'),
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
      if (action === 'save' || action === 'retry') openSave();
      else if (action === 'test') test();
      else if (action === 'publish') publish();
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
