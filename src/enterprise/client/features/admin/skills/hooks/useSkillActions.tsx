'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { invalidatePublishedSkillCatalog } from '@/enterprise/client/features/skills';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';

import {
  buildSkillUpdatePayload,
  fingerprintSkillSnapshot,
  isSkillIdentityDirty,
  type SkillPermissions,
  summarizeSkillValidation,
} from '../controller';
import { createInitialSkillVersionDraft, openVersionEditorModal } from '../openVersionEditorModal';
import type {
  AdminSkillArchiveInput,
  AdminSkillGetOutput,
  AdminSkillPublishInput,
  AdminSkillRollbackInput,
  AdminSkillUpdateDraftInput,
  AdminSkillValidateInput,
  AdminSkillValidateOutput,
} from '../types';
import { createSkillWriteEpochGuard, freezeSkillWriteSnapshot } from '../writeOperation';
import { refreshAdminSkill } from './useAdminSkills';
import type { useSkillEditor } from './useSkillEditor';

type SkillEditor = ReturnType<typeof useSkillEditor>;

interface UseSkillActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  data: AdminSkillGetOutput;
  editor: SkillEditor;
  permissions: SkillPermissions;
  selectedValidation: AdminSkillValidateOutput | null;
  selectedVersionId?: string;
}

export const useSkillActions = ({
  authMethod,
  data,
  editor,
  permissions,
  selectedValidation,
  selectedVersionId,
}: UseSkillActionsParams) => {
  const { t } = useTranslation('admin');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [validation, setValidation] = useState<AdminSkillValidateOutput | null>(selectedValidation);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const writeGuardRef = useRef(createSkillWriteEpochGuard());
  const committedVerifierRef = useRef<(() => Promise<boolean>) | null>(null);
  const resourceIdRef = useRef(data.draft.id);
  const writeGuard = writeGuardRef.current;
  if (resourceIdRef.current !== data.draft.id) {
    resourceIdRef.current = data.draft.id;
    writeGuard.invalidate();
  }

  useEffect(() => {
    setValidation(selectedValidation);
  }, [selectedValidation, selectedVersionId]);

  const errorText = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      return mapped
        ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
        : t('skillCatalog.errors.generic');
    },
    [t],
  );

  const handleMutationError = useCallback(
    async (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        writeGuard.invalidate();
        editor.setConflict(true);
        try {
          await refreshAdminSkill(data.draft.id);
        } catch {
          // Local input remains in the editor; the conflict UI offers refresh/rebase.
        }
      }
      editor.setActionError(errorText(cause));
    },
    [data.draft.id, editor, errorText, writeGuard],
  );

  const commitAndRefresh = useCallback(
    async <Result,>(params: {
      commit: () => Promise<Result>;
      onCommitted?: (result: Result) => Promise<void> | void;
      previousFingerprint: string;
      recover?: (result: Result) => Promise<void>;
      verify?: (
        latest: AdminSkillGetOutput | undefined,
        result: Result,
      ) => boolean | Promise<boolean>;
    }) => {
      // Server commit first; post-commit side effects never reverse a successful write.
      const result = await params.commit();
      writeGuard.lock();
      // Local state finalization and success feedback are one-shot commit effects. They must not
      // be replayed when a later cache refresh/verification retry is requested.
      await params.onCommitted?.(result);

      const verify = async () => {
        await params.recover?.(result);
        const latest = await refreshAdminSkill(data.draft.id);
        if (params.verify) return params.verify(latest, result);
        return Boolean(latest && fingerprintSkillSnapshot(latest) !== params.previousFingerprint);
      };
      // Only idempotent cache invalidation and freshness verification are retryable.
      committedVerifierRef.current = verify;

      try {
        if (!(await verify())) throw new Error('Committed Skill snapshot has not advanced');
        committedVerifierRef.current = null;
        setRefreshFailed(false);
        editor.setActionError(null);
        writeGuard.unlock();
      } catch {
        setRefreshFailed(true);
        editor.setActionError(t('skillCatalog.refresh.failed'));
      }
      return result;
    },
    [data.draft.id, editor, t, writeGuard],
  );

  const retryRefresh = useCallback(async () => {
    setActionLoading('refresh');
    try {
      const verify = committedVerifierRef.current;
      if (!verify || !(await verify())) {
        throw new Error('Committed Skill snapshot has not advanced');
      }
      committedVerifierRef.current = null;
      setRefreshFailed(false);
      editor.setActionError(null);
      writeGuard.unlock();
    } catch {
      setRefreshFailed(true);
      editor.setActionError(t('skillCatalog.refresh.failed'));
    } finally {
      setActionLoading(null);
    }
  }, [editor, t, writeGuard]);

  const openSaveIdentity = useCallback(() => {
    if (
      !permissions.canUpdate ||
      !editor.draft ||
      !isSkillIdentityDirty(editor.draft, editor.baseDraft) ||
      editor.conflict ||
      refreshFailed
    ) {
      return;
    }
    const epoch = writeGuard.begin(data.draft.id);
    if (epoch === null) return;
    const operation = freezeSkillWriteSnapshot(data);
    const identity = structuredClone(editor.draft.identity);
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) =>
        buildSkillUpdatePayload({
          draft: identity,
          draftToken: operation.draftToken,
          id: operation.id,
          reason,
          revision: operation.baseRevision,
        }),
      description: t('skillCatalog.actions.save.desc'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch, operation.id);
        setActionLoading('save');
        editor.setSaveState('saving');
        try {
          await commitAndRefresh({
            commit: () => adminSkillsService.updateDraft(input as AdminSkillUpdateDraftInput),
            onCommitted: () => {
              editor.markSaved();
              toast.success(t('skillCatalog.toast.saved'));
            },
            previousFingerprint: operation.fingerprint,
          });
        } catch (cause) {
          editor.setSaveState('failed');
          await handleMutationError(cause);
          throw cause;
        } finally {
          setActionLoading(null);
        }
      },
      submitLabel: t('skillCatalog.actions.save.label'),
      targetLabel: data.draft.displayName,
      title: t('skillCatalog.actions.save.title'),
      validateExtra: () => (identity.displayName.trim() ? null : 'skillCatalog.form.required'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions.canUpdate,
    refreshFailed,
    t,
    writeGuard,
  ]);

  const openCreateVersion = useCallback(() => {
    if (!permissions.canUpdate || !editor.draft || editor.conflict || refreshFailed) return;
    const epoch = writeGuard.begin(data.draft.id);
    if (epoch === null) return;
    const operation = freezeSkillWriteSnapshot(data);
    const initialDraft =
      editor.draft.versionDraft ??
      createInitialSkillVersionDraft(data.draft.displayName, data.draft.description);
    openVersionEditorModal({
      initialDraft,
      onDraftChange: editor.updateVersionDraft,
      snapshot: operation,
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch, operation.id);
        setActionLoading('version');
        try {
          await commitAndRefresh({
            commit: () => adminSkillsService.createVersion(input),
            onCommitted: () => {
              editor.markVersionSaved();
              toast.success(t('skillCatalog.toast.versionCreated'));
            },
            previousFingerprint: operation.fingerprint,
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        } finally {
          setActionLoading(null);
        }
      },
    });
  }, [
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions.canUpdate,
    refreshFailed,
    t,
    writeGuard,
  ]);

  const openValidate = useCallback(() => {
    if (
      !permissions.canUpdate ||
      !selectedVersionId ||
      editor.dirty ||
      editor.conflict ||
      refreshFailed
    )
      return;
    const epoch = writeGuard.begin(data.draft.id);
    if (epoch === null) return;
    const operation = freezeSkillWriteSnapshot(data, { versionId: selectedVersionId });
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        expectedDraftToken: operation.draftToken,
        expectedRevision: operation.baseRevision,
        reason,
        skillId: operation.id,
        versionId: operation.versionId!,
      }),
      description: t('skillCatalog.actions.validate.desc'),
      onSubmit: async (input) => {
        writeGuard.assertCurrent(epoch, operation.id);
        setActionLoading('validate');
        try {
          await commitAndRefresh({
            commit: () => adminSkillsService.validate(input as AdminSkillValidateInput),
            onCommitted: (result) => {
              setValidation(result);
              toast[
                result.issues.some((issue) => issue.severity === 'error') ? 'warning' : 'success'
              ](t('skillCatalog.toast.validated'));
            },
            previousFingerprint: operation.fingerprint,
            verify: async (_latest, result) => {
              const version = await adminSkillsService.getVersion({
                skillId: operation.id,
                versionId: operation.versionId!,
              });
              return JSON.stringify(version.validation) === JSON.stringify(result);
            },
          });
        } catch (cause) {
          await handleMutationError(cause);
          throw cause;
        } finally {
          setActionLoading(null);
        }
      },
      submitLabel: t('skillCatalog.actions.validate.label'),
      targetLabel: data.draft.displayName,
      title: t('skillCatalog.actions.validate.title'),
    });
  }, [
    authMethod,
    commitAndRefresh,
    data,
    editor,
    handleMutationError,
    permissions.canUpdate,
    refreshFailed,
    selectedVersionId,
    t,
    writeGuard,
  ]);

  const openPublication = useCallback(
    (kind: 'archive' | 'publish' | 'rollback', targetVersionId?: string) => {
      const allowed = kind === 'archive' ? permissions.canArchive : permissions.canPublish;
      if (!allowed || editor.dirty || editor.conflict || refreshFailed) return;
      if ((kind === 'publish' || kind === 'rollback') && !targetVersionId) return;
      if (kind === 'publish' && !summarizeSkillValidation(validation).publishable) return;
      const epoch = writeGuard.begin(data.draft.id);
      if (epoch === null) return;
      const operation = freezeSkillWriteSnapshot(
        data,
        kind === 'publish' ? { versionId: targetVersionId } : { targetVersionId },
      );
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          expectedDraftToken: operation.draftToken,
          expectedRevision: operation.baseRevision,
          id: operation.id,
          reason,
          ...(kind === 'publish' ? { versionId: operation.versionId } : {}),
          ...(kind === 'rollback' ? { targetVersionId: operation.targetVersionId } : {}),
        }),
        danger: kind !== 'publish',
        description: t(`skillCatalog.actions.${kind}.desc` as never),
        impact: t(`skillCatalog.actions.${kind}.impact` as never),
        onSubmit: async (input) => {
          writeGuard.assertCurrent(epoch, operation.id);
          setActionLoading(kind);
          try {
            await commitAndRefresh({
              commit: () =>
                kind === 'publish'
                  ? adminSkillsService.publish(input as AdminSkillPublishInput)
                  : kind === 'rollback'
                    ? adminSkillsService.rollback(input as AdminSkillRollbackInput)
                    : adminSkillsService.archive(input as AdminSkillArchiveInput),
              onCommitted: () => {
                toast.success(t(`skillCatalog.toast.${kind}` as never));
              },
              previousFingerprint: operation.fingerprint,
              recover: (result) => invalidatePublishedSkillCatalog(result.catalogRevision),
            });
          } catch (cause) {
            await handleMutationError(cause);
            throw cause;
          } finally {
            setActionLoading(null);
          }
        },
        submitLabel: t(`skillCatalog.actions.${kind}.label` as never),
        targetLabel: data.draft.displayName,
        title: t(`skillCatalog.actions.${kind}.title` as never),
      });
    },
    [
      authMethod,
      commitAndRefresh,
      data,
      editor,
      handleMutationError,
      permissions.canArchive,
      permissions.canPublish,
      refreshFailed,
      t,
      validation,
      writeGuard,
    ],
  );

  return {
    actionLoading,
    canPublishSelected: summarizeSkillValidation(validation).publishable,
    openArchive: () => openPublication('archive'),
    openCreateVersion,
    openPublish: () => openPublication('publish', selectedVersionId),
    openRollback: (targetVersionId: string) => openPublication('rollback', targetVersionId),
    openSaveIdentity,
    openValidate,
    refreshFailed,
    retryRefresh,
    validation,
  };
};
