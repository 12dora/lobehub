'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Select, toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { deriveAdminAgentPermissions } from './controller';
import { toDependencySnapshot } from './dependencyCatalog';
import type { AdminAgentDetailOutput, AdminPlatformAgentAppendVersionOutput } from './types';
import { fetchAllAdminAgents } from './useAdminAgents';
import type { useAgentEditor } from './useAgentEditor';
import type { RefreshLock } from './useRefreshLock';

type IdentityMutationOutput = Pick<AdminAgentDetailOutput, 'draftToken' | 'identity'>;

interface UseAgentActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  editor: ReturnType<typeof useAgentEditor>;
  lock: RefreshLock;
  mutate: KeyedMutator<AdminAgentDetailOutput>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  snapshot: AdminAgentDetailOutput;
}

const ArchiveReplacementField = ({
  candidates,
  disabled,
  isDefault,
  onChange,
}: {
  candidates: { label: string; value: string }[];
  disabled: boolean;
  isDefault: boolean;
  onChange: (value: string | null) => void;
}) => {
  const { t } = useTranslation('admin');
  const [value, setValue] = useState<string>();
  if (!isDefault) return null;
  return (
    <Flexbox gap={6}>
      <Text strong>{t('agentCatalog.archive.replacement')}</Text>
      <Select
        aria-label={t('agentCatalog.archive.replacement')}
        disabled={disabled}
        options={candidates}
        placeholder={t('agentCatalog.archive.replacementPlaceholder')}
        value={value}
        onChange={(next) => {
          const id = (next as string | undefined) ?? null;
          setValue(id ?? undefined);
          onChange(id);
        }}
      />
      {candidates.length === 0 ? (
        <Text type="danger">{t('agentCatalog.archive.noReplacement')}</Text>
      ) : null}
    </Flexbox>
  );
};

/** Merge an authoritative identity/draftToken mutation output into the cached detail. */
const applyIdentity =
  (output: IdentityMutationOutput) =>
  (current?: AdminAgentDetailOutput): AdminAgentDetailOutput | undefined =>
    current ? { ...current, draftToken: output.draftToken, identity: output.identity } : current;

const applyAppendVersion =
  (output: AdminPlatformAgentAppendVersionOutput) =>
  (current?: AdminAgentDetailOutput): AdminAgentDetailOutput | undefined =>
    current
      ? {
          ...current,
          draftToken: output.draftToken,
          identity: output.identity,
          versions: [output.version, ...current.versions],
        }
      : current;

export const useAgentActions = ({
  authMethod,
  editor,
  lock,
  mutate,
  permissions,
  snapshot,
}: UseAgentActionsParams) => {
  const { t } = useTranslation('admin');

  const save = useCallback(() => {
    // Locked after a committed change whose refresh failed → block the stale-CAS write.
    if (lock.isLocked() || !permissions.canUpdate || !editor.draft) return;
    const dependencySnapshot = toDependencySnapshot(editor.draft.dependencies);
    if (!dependencySnapshot) {
      toast.error(t('agentCatalog.dependency.model.required'));
      return;
    }
    const config = structuredClone(editor.draft.config);
    const version = editor.draft.version;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        agentId: snapshot.identity.id,
        config,
        dependencySnapshot,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
        version,
      }),
      description: t('agentCatalog.save.description'),
      onSubmit: async (input) => {
        if (lock.isLocked()) return; // defence in depth against a stale-CAS resubmission
        editor.setSaveState('saving');
        let output: AdminPlatformAgentAppendVersionOutput;
        try {
          output = await adminAgentsService.appendVersion(
            input as Parameters<typeof adminAgentsService.appendVersion>[0],
          );
        } catch (cause) {
          editor.setSaveState('failed');
          if (cause instanceof Error && cause.message.includes('CONFLICT'))
            editor.setConflict(true);
          throw cause;
        }
        // Committed: clear recovery, advance CAS from the authoritative output (no stale CAS).
        editor.markSaved();
        await mutate(applyAppendVersion(output), { revalidate: false });
        toast.success(t('agentCatalog.toast.saved'));
      },
      submitLabel: t('agentCatalog.action.saveVersion'),
      targetLabel: snapshot.identity.agentKey,
      title: t('agentCatalog.save.title'),
    });
  }, [authMethod, editor, lock, mutate, permissions.canUpdate, snapshot, t]);

  const publish = useCallback(
    (versionId: string) => {
      if (lock.isLocked()) return;
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          agentId: snapshot.identity.id,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
          reason,
          versionId,
        }),
        description: t('agentCatalog.publish.description'),
        onSubmit: async (input) => {
          if (lock.isLocked()) return;
          await adminAgentsService.publish(
            input as Parameters<typeof adminAgentsService.publish>[0],
          );
          // publish output carries no draftToken → revalidate; lock on failure.
          await lock.syncAfterCommit();
          toast.success(t('agentCatalog.toast.published'));
        },
        submitLabel: t('agentCatalog.publish.submit'),
        targetLabel: snapshot.identity.agentKey,
        title: t('agentCatalog.publish.title'),
      });
    },
    [authMethod, lock, snapshot, t],
  );

  const rollback = useCallback(
    (versionId: string) => {
      if (lock.isLocked()) return;
      openReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          agentId: snapshot.identity.id,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
          reason,
          targetVersionId: versionId,
        }),
        danger: true,
        description: t('agentCatalog.rollback.description'),
        onSubmit: async (input) => {
          if (lock.isLocked()) return;
          await adminAgentsService.rollback(
            input as Parameters<typeof adminAgentsService.rollback>[0],
          );
          await lock.syncAfterCommit();
          toast.success(t('agentCatalog.toast.rolledBack'));
        },
        submitLabel: t('agentCatalog.rollback.submit'),
        targetLabel: snapshot.identity.agentKey,
        title: t('agentCatalog.rollback.title'),
      });
    },
    [authMethod, lock, snapshot, t],
  );

  const setDefaultInbox = useCallback(async () => {
    if (lock.isLocked()) return;
    // Resolve the outgoing default's exact CAS BEFORE opening the modal, then freeze it.
    const currentDefaultIdentity = (await fetchAllAdminAgents({}, adminAgentsService)).find(
      ({ identity }) => identity.isDefault,
    )?.identity;
    const currentDefault =
      currentDefaultIdentity && currentDefaultIdentity.id !== snapshot.identity.id
        ? await adminAgentsService.get({ id: currentDefaultIdentity.id })
        : null;
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        currentDefault: currentDefault
          ? {
              agentId: currentDefault.identity.id,
              expectedDraftToken: currentDefault.draftToken,
              expectedRevision: currentDefault.identity.revision,
            }
          : null,
        nextDefault: {
          agentId: snapshot.identity.id,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: snapshot.identity.revision,
        },
        reason,
      }),
      danger: true,
      description: t('agentCatalog.defaultSwitch.description'),
      onSubmit: async (input) => {
        if (lock.isLocked()) return;
        const output = await adminAgentsService.setDefaultInbox(
          input as Parameters<typeof adminAgentsService.setDefaultInbox>[0],
        );
        // nextDefault carries the authoritative CAS for this agent → advance locally.
        await mutate(applyIdentity(output.nextDefault), { revalidate: false });
        toast.success(t('agentCatalog.defaultSwitch.success'));
      },
      submitLabel: t('agentCatalog.defaultSwitch.submit'),
      targetLabel: snapshot.identity.agentKey,
      title: t('agentCatalog.defaultSwitch.title'),
    });
  }, [authMethod, lock, mutate, snapshot, t]);

  const archive = useCallback(async () => {
    if (lock.isLocked()) return;
    const candidates = snapshot.identity.isDefault
      ? (await fetchAllAdminAgents({ status: 'published' }, adminAgentsService))
          .filter(({ identity }) => identity.id !== snapshot.identity.id)
          .map(({ displayName, identity }) => ({ label: displayName, value: identity.id }))
      : [];
    const replacementRef: { current: string | null } = { current: null };
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        agentId: snapshot.identity.id,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason,
        replacementAgentId: replacementRef.current,
      }),
      danger: true,
      description: t('agentCatalog.archive.description'),
      extra: ({ locked }) => (
        <ArchiveReplacementField
          candidates={candidates}
          disabled={locked}
          isDefault={snapshot.identity.isDefault}
          onChange={(value) => {
            replacementRef.current = value;
          }}
        />
      ),
      onSubmit: async (input) => {
        if (lock.isLocked()) return;
        const output = await adminAgentsService.archive(
          input as Parameters<typeof adminAgentsService.archive>[0],
        );
        await mutate(applyIdentity(output), { revalidate: false });
        toast.success(t('agentCatalog.toast.archived'));
      },
      submitLabel: t('agentCatalog.archive.submit'),
      targetLabel: snapshot.identity.agentKey,
      title: t('agentCatalog.archive.title'),
      validateExtra: () =>
        snapshot.identity.isDefault && !replacementRef.current
          ? 'agentCatalog.archive.noReplacement'
          : null,
    });
  }, [authMethod, lock, mutate, snapshot, t]);

  return {
    archive,
    publish,
    refreshFailed: lock.refreshFailed,
    retryRefresh: lock.retryRefresh,
    rollback,
    save,
    setDefaultInbox,
  };
};
