'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Input, Select, toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AGENT_ARCHIVE_AUTO_REASON } from '@/enterprise/client/features/admin/audit/shared/auditReasonCodes';
import { openDangerConfirm } from '@/enterprise/client/features/admin/primitives/DangerConfirm';
import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import { getAdminAgentErrorMessage } from './errorPresentation';
import type { AdminAgentListItem } from './types';
import { useAdminAgentReplacementCandidates } from './useAdminAgentReplacementCandidates';
import { findDefaultAdminAgent } from './useAdminAgents';

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

/**
 * Stable machine audit reason for archive, localized at render time. Archive keeps a confirmation
 * because it also collects the replacement Agent, but the operator no longer types a reason
 * (mirrors delete).
 */
const ARCHIVE_REASON = AGENT_ARCHIVE_AUTO_REASON;

export interface UseAgentRowActionsParams {
  authMethod: AdminReauthAuthMethod | null;
  /**
   * Revalidate the bound list. Both actions change identity fields the list renders (status /
   * isDefault) on rows the output does not fully describe — the outgoing default row changes too —
   * so the list is refetched rather than patched into a half-truth.
   */
  onChanged: () => Promise<void>;
}

/**
 * 设为默认助理 / 归档助理 for a list row.
 *
 * Both used to live on the assistant detail page behind a shared refresh lock. The list has no
 * detail cache to keep coherent, so the lock is replaced by the same discipline the delete row
 * action already uses: read the authoritative CAS immediately before opening the modal, freeze it
 * for the write, then revalidate the list.
 */
export const useAgentRowActions = ({ authMethod, onChanged }: UseAgentRowActionsParams) => {
  const { t } = useTranslation('admin');

  const refresh = useCallback(async () => {
    try {
      await onChanged();
    } catch {
      toast.warning(t('agentCatalog.recovery.refreshFailed'));
    }
  }, [onChanged, t]);

  const setDefaultInbox = useCallback(
    async (item: AdminAgentListItem) => {
      let payload;
      try {
        // Resolve BOTH sides' exact CAS before opening the modal, then freeze them. The outgoing
        // default is found by a dedicated `isDefault` list read — never a catalog page walk.
        const next = await adminAgentsService.get({ id: item.identity.id });
        const currentDefaultIdentity = (await findDefaultAdminAgent(adminAgentsService))?.identity;
        const currentDefault =
          currentDefaultIdentity && currentDefaultIdentity.id !== item.identity.id
            ? await adminAgentsService.get({ id: currentDefaultIdentity.id })
            : null;
        payload = {
          currentDefault: currentDefault
            ? {
                agentId: currentDefault.identity.id,
                expectedDraftToken: currentDefault.draftToken,
                expectedRevision: currentDefault.identity.revision,
              }
            : null,
          nextDefault: {
            agentId: next.identity.id,
            expectedDraftToken: next.draftToken,
            expectedRevision: next.identity.revision,
          },
        };
      } catch {
        // Preflight failed — never open a confirmation on unknown CAS.
        toast.error(t('agentCatalog.toast.actionFailed'));
        return;
      }
      openDangerConfirm({
        confirmText: t('agentCatalog.defaultSwitch.submit'),
        content: t('agentCatalog.defaultSwitch.description'),
        title: t('agentCatalog.defaultSwitch.title'),
        onConfirm: async () => {
          const committed = await runAdminMutation({
            authMethod,
            run: async () => {
              await adminAgentsService.setDefaultInbox(payload);
            },
          });
          if (!committed) return;
          // Two rows changed (the new default and the outgoing one) — refresh, do not patch.
          await refresh();
          toast.success(t('agentCatalog.defaultSwitch.success'));
        },
      });
    },
    [authMethod, refresh, t],
  );

  const archive = useCallback(
    async (item: AdminAgentListItem) => {
      let snapshot;
      try {
        snapshot = await adminAgentsService.get({ id: item.identity.id });
      } catch (cause) {
        toast.error(getAdminAgentErrorMessage(cause, t));
        return;
      }
      const identity = snapshot.identity;
      // Replacement candidates load inside the searchable picker (one page + remote query) —
      // never pre-drain the published catalog into the modal.
      const replacementRef: { current: string | null } = { current: null };
      openReasonModal({
        authMethod: authMethod ?? undefined,
        autoReason: ARCHIVE_REASON,
        buildPayload: (reason) => ({
          agentId: identity.id,
          expectedDraftToken: snapshot.draftToken,
          expectedRevision: identity.revision,
          reason,
          replacementAgentId: replacementRef.current,
        }),
        danger: true,
        description: t('agentCatalog.archive.description'),
        hideReason: true,
        // `reportExtraChange` is how the modal knows to re-run `validateExtra`. Without it the
        // submit button stays permanently disabled after a replacement is chosen.
        extra: ({ locked, reportExtraChange }) => (
          <ArchiveReplacementField
            disabled={locked}
            excludeAgentId={identity.id}
            isDefault={identity.isDefault}
            onChange={(value) => {
              replacementRef.current = value;
              reportExtraChange();
            }}
          />
        ),
        // Throwing is the contract: the modal owns the reauth retry and the error surface.
        onSubmit: async (input) => {
          await adminAgentsService.archive(
            input as Parameters<typeof adminAgentsService.archive>[0],
          );
          await refresh();
          toast.success(t('agentCatalog.toast.archived'));
        },
        submitLabel: t('agentCatalog.archive.submit'),
        targetLabel: identity.agentKey,
        title: t('agentCatalog.archive.title'),
        // The server refuses to archive the default assistant without a successor; say so here
        // instead of letting the write fail.
        validateExtra: () =>
          identity.isDefault && !replacementRef.current
            ? 'agentCatalog.archive.noReplacement'
            : null,
      });
    },
    [authMethod, refresh, t],
  );

  return { archive, setDefaultInbox };
};
