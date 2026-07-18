'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Select, toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import {
  type AdminReauthAuthMethod,
  isAdminReauthRequiredError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { adminPlatformAgentAppendVersionInputSchema } from '@/server/enterprise/contracts/platformAgents';

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
    // The draft must be submitted against the exact CAS it was authored from. This synchronous
    // guard also protects direct/programmatic calls that bypass the disabled Save button during a
    // refresh race. Never bind a dirty draft to the newer live snapshot implicitly.
    const baseline = editor.draftBaseline;
    if (
      editor.conflict ||
      !baseline ||
      baseline.agentId !== snapshot.identity.id ||
      baseline.revision !== snapshot.identity.revision ||
      baseline.draftToken !== snapshot.draftToken
    ) {
      editor.setConflict(true);
      return;
    }
    const { agentId, draftToken: expectedDraftToken, revision: expectedRevision } = baseline;
    const dependencySnapshot = toDependencySnapshot(editor.draft.dependencies);
    if (!dependencySnapshot) {
      toast.error(t('agentCatalog.dependency.model.required'));
      return;
    }
    const config = structuredClone(editor.draft.config);
    const version = editor.draft.version;
    // Recovery storage intentionally accepts temporarily incomplete form values. The complete
    // append-version contract is enforced only at this explicit submission boundary.
    if (
      !adminPlatformAgentAppendVersionInputSchema.safeParse({
        agentId,
        config,
        dependencySnapshot,
        expectedDraftToken,
        expectedRevision,
        reason: 'validate recovered Agent draft',
        version,
      }).success
    ) {
      editor.setSaveState('failed');
      toast.error(t('agentCatalog.save.invalid'));
      return;
    }
    // One token for this logical write — captured by both submit and the reauth-abort hook so the
    // shared-reauth retry is recognised as the SAME write and a cancel releases the frozen baseline.
    const writeToken = {};
    openReasonModal({
      authMethod: authMethod ?? undefined,
      buildPayload: (reason) => ({
        agentId,
        config,
        dependencySnapshot,
        expectedDraftToken,
        expectedRevision,
        reason,
        version,
      }),
      description: t('agentCatalog.save.description'),
      onPhaseChange: (phase) => {
        if (phase === 'idle') lock.abortWrite(writeToken); // reauth cancel / terminal → unlock if uncommitted
      },
      onSubmit: async (input) => {
        if (!lock.beginWrite(writeToken)) return; // lock BEFORE the service; reject concurrent writes
        editor.setSaveState('saving');
        let output: AdminPlatformAgentAppendVersionOutput;
        try {
          output = await adminAgentsService.appendVersion(
            input as Parameters<typeof adminAgentsService.appendVersion>[0],
          );
        } catch (cause) {
          if (isAdminReauthRequiredError(cause)) throw cause; // retryable: keep the frozen baseline
          lock.abortWrite(writeToken);
          editor.setSaveState('failed');
          if (cause instanceof Error && cause.message.includes('CONFLICT'))
            editor.setConflict(true);
          throw cause;
        }
        // Committed on the server — mark synchronously BEFORE any cache apply, so an idle/finally can
        // never abort a committed write.
        lock.markCommitted(writeToken);
        editor.markSaved({
          agentId: output.identity.id,
          draftToken: output.draftToken,
          revision: output.identity.revision,
        });
        try {
          await mutate(applyAppendVersion(output), { revalidate: false });
          lock.resolveWrite(writeToken); // output carries the advanced CAS → end the cycle, no refresh
        } catch {
          // The local cache apply failed AFTER the commit → stay locked and refresh the authoritative
          // aggregate against the frozen baseline; only a complete fresh aggregate unlocks.
          await lock.commitWrite(writeToken);
        }
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
      const writeToken = {};
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
        onPhaseChange: (phase) => {
          if (phase === 'idle') lock.abortWrite(writeToken);
        },
        onSubmit: async (input) => {
          if (!lock.beginWrite(writeToken)) return;
          try {
            await adminAgentsService.publish(
              input as Parameters<typeof adminAgentsService.publish>[0],
            );
          } catch (cause) {
            if (isAdminReauthRequiredError(cause)) throw cause;
            lock.abortWrite(writeToken);
            throw cause;
          }
          // publish output carries no draftToken → refresh; stays locked on a non-advanced refresh.
          lock.markCommitted(writeToken);
          await lock.commitWrite(writeToken);
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
      const writeToken = {};
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
        onPhaseChange: (phase) => {
          if (phase === 'idle') lock.abortWrite(writeToken);
        },
        onSubmit: async (input) => {
          if (!lock.beginWrite(writeToken)) return;
          try {
            await adminAgentsService.rollback(
              input as Parameters<typeof adminAgentsService.rollback>[0],
            );
          } catch (cause) {
            if (isAdminReauthRequiredError(cause)) throw cause;
            lock.abortWrite(writeToken);
            throw cause;
          }
          lock.markCommitted(writeToken);
          await lock.commitWrite(writeToken);
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
    let currentDefault: Awaited<ReturnType<typeof adminAgentsService.get>> | null;
    try {
      // Resolve the outgoing default's exact CAS BEFORE opening the modal, then freeze it.
      const currentDefaultIdentity = (await fetchAllAdminAgents({}, adminAgentsService)).find(
        ({ identity }) => identity.isDefault,
      )?.identity;
      currentDefault =
        currentDefaultIdentity && currentDefaultIdentity.id !== snapshot.identity.id
          ? await adminAgentsService.get({ id: currentDefaultIdentity.id })
          : null;
    } catch (cause) {
      console.error(cause);
      toast.error(t('agentCatalog.toast.actionFailed'));
      return;
    }
    const writeToken = {};
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
      onPhaseChange: (phase) => {
        if (phase === 'idle') lock.abortWrite(writeToken);
      },
      onSubmit: async (input) => {
        if (!lock.beginWrite(writeToken)) return;
        let output: Awaited<ReturnType<typeof adminAgentsService.setDefaultInbox>>;
        try {
          output = await adminAgentsService.setDefaultInbox(
            input as Parameters<typeof adminAgentsService.setDefaultInbox>[0],
          );
        } catch (cause) {
          if (isAdminReauthRequiredError(cause)) throw cause;
          lock.abortWrite(writeToken);
          throw cause;
        }
        // Committed on the server → mark synchronously before any cache apply.
        lock.markCommitted(writeToken);
        try {
          // nextDefault carries the authoritative CAS for this agent → advance locally, end the cycle.
          await mutate(applyIdentity(output.nextDefault), { revalidate: false });
          lock.resolveWrite(writeToken);
        } catch {
          await lock.commitWrite(writeToken); // cache apply failed after commit → refresh-required
        }
        toast.success(t('agentCatalog.defaultSwitch.success'));
      },
      submitLabel: t('agentCatalog.defaultSwitch.submit'),
      targetLabel: snapshot.identity.agentKey,
      title: t('agentCatalog.defaultSwitch.title'),
    });
  }, [authMethod, lock, mutate, snapshot, t]);

  const archive = useCallback(async () => {
    if (lock.isLocked()) return;
    let candidates: { label: string; value: string }[];
    try {
      candidates = snapshot.identity.isDefault
        ? (await fetchAllAdminAgents({ status: 'published' }, adminAgentsService))
            .filter(({ identity }) => identity.id !== snapshot.identity.id)
            .map(({ displayName, identity }) => ({ label: displayName, value: identity.id }))
        : [];
    } catch (cause) {
      console.error(cause);
      toast.error(t('agentCatalog.toast.actionFailed'));
      return;
    }
    const replacementRef: { current: string | null } = { current: null };
    const writeToken = {};
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
      onPhaseChange: (phase) => {
        if (phase === 'idle') lock.abortWrite(writeToken);
      },
      onSubmit: async (input) => {
        if (!lock.beginWrite(writeToken)) return;
        let output: Awaited<ReturnType<typeof adminAgentsService.archive>>;
        try {
          output = await adminAgentsService.archive(
            input as Parameters<typeof adminAgentsService.archive>[0],
          );
        } catch (cause) {
          if (isAdminReauthRequiredError(cause)) throw cause;
          lock.abortWrite(writeToken);
          throw cause;
        }
        lock.markCommitted(writeToken); // committed on the server → mark before any cache apply
        try {
          await mutate(applyIdentity(output), { revalidate: false });
          lock.resolveWrite(writeToken);
        } catch {
          await lock.commitWrite(writeToken); // cache apply failed after commit → refresh-required
        }
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
