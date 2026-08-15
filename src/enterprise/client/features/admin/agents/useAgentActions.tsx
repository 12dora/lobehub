'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Input, Select, toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import {
  type AdminReauthAuthMethod,
  isAdminReauthRequiredError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { AdminAgentDetailOutput } from './types';
import { useAdminAgentReplacementCandidates } from './useAdminAgentReplacementCandidates';
import { findDefaultAdminAgent } from './useAdminAgents';
import type { RefreshLock } from './useRefreshLock';

type IdentityMutationOutput = Pick<AdminAgentDetailOutput, 'draftToken' | 'identity'>;

interface UseAgentActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  lock: RefreshLock;
  mutate: KeyedMutator<AdminAgentDetailOutput>;
  snapshot: AdminAgentDetailOutput;
}

/**
 * Searchable published-agent picker for archive-default replacement. SWR owns fetch/cache/retry;
 * only the selected replacement id is local component state.
 */
const ArchiveReplacementField = ({
  disabled,
  excludeAgentId,
  isDefault,
  onChange,
}: {
  disabled: boolean;
  excludeAgentId: string;
  isDefault: boolean;
  onChange: (value: string | null) => void;
}) => {
  const { t } = useTranslation('admin');
  const [value, setValue] = useState<string>();
  const [search, setSearch] = useState('');
  const candidates = useAdminAgentReplacementCandidates(excludeAgentId, search, isDefault);

  const options = useMemo(
    () =>
      (candidates.data ?? []).map(({ displayName, identity }) => ({
        label: displayName,
        value: identity.id,
      })),
    [candidates.data],
  );

  if (!isDefault) return null;
  return (
    <Flexbox gap={6}>
      <Text strong>{t('agentCatalog.archive.replacement')}</Text>
      <Select
        showSearch
        aria-label={t('agentCatalog.archive.replacement')}
        disabled={disabled}
        loading={Boolean(candidates.isLoading || candidates.isValidating)}
        options={options}
        placeholder={t('agentCatalog.archive.replacementPlaceholder')}
        value={value}
        onChange={(next) => {
          const id = (next as string | undefined) ?? null;
          setValue(id ?? undefined);
          onChange(id);
        }}
      />
      {/* Server-side catalog search (one page). Local Select showSearch only filters the loaded page. */}
      <Input
        aria-label={t('agentCatalog.archive.replacementPlaceholder')}
        disabled={disabled}
        placeholder={t('agentCatalog.archive.replacementPlaceholder')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {candidates.error ? <Text type="danger">{t('agentCatalog.toast.actionFailed')}</Text> : null}
      {!candidates.error && candidates.data && candidates.data.length === 0 ? (
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

export const useAgentActions = ({ authMethod, lock, mutate, snapshot }: UseAgentActionsParams) => {
  const { t } = useTranslation('admin');

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
          let invalidationDeferred: boolean;
          try {
            const result = await adminAgentsService.rollback(
              input as Parameters<typeof adminAgentsService.rollback>[0],
            );
            invalidationDeferred = result.invalidationStatus === 'deferred';
            if (invalidationDeferred) {
              toast.warning(t('agentCatalog.toast.refreshDeferred'));
            }
          } catch (cause) {
            if (isAdminReauthRequiredError(cause)) throw cause;
            lock.abortWrite(writeToken);
            throw cause;
          }
          lock.markCommitted(writeToken);
          await lock.commitWrite(writeToken);
          if (!invalidationDeferred) toast.success(t('agentCatalog.toast.rolledBack'));
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
      // Early-exit page walk — never drain the full catalog just to find one default row.
      const currentDefaultIdentity = (await findDefaultAdminAgent(adminAgentsService))?.identity;
      currentDefault =
        currentDefaultIdentity && currentDefaultIdentity.id !== snapshot.identity.id
          ? await adminAgentsService.get({ id: currentDefaultIdentity.id })
          : null;
    } catch {
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
    // Replacement candidates load inside the searchable picker (one page + remote query) —
    // never pre-drain the published catalog into the modal.
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
          disabled={locked}
          excludeAgentId={snapshot.identity.id}
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
    refreshFailed: lock.refreshFailed,
    retryRefresh: lock.retryRefresh,
    rollback,
    setDefaultInbox,
  };
};
