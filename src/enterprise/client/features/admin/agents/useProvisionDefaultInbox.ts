'use client';

import { confirmModal, toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { AdminAgentsClient } from './types';
import type { AdminAgentRefresh } from './useAdminAgentRefresh';

export interface UseProvisionDefaultInboxParams {
  authMethod: AdminReauthAuthMethod | null;
  client?: AdminAgentsClient;
  /** The provisioned assistant is empty until it is authored — hand the admin its editor. */
  onProvisioned: (agentId: string) => Promise<void> | void;
  /**
   * The shared both-surfaces invalidator (`useAdminAgentRefresh(...).defaultAndList`): the Agent
   * this writes IS the new default and a table row that did not exist a moment ago.
   */
  refresh: AdminAgentRefresh['defaultAndList'];
}

/**
 * 开始托管默认助理.
 *
 * Provisioning replaces the built-in inbox every member currently sees with a platform Agent, so
 * it asks first — this is the one write on this page whose blast radius is "everyone", and it is
 * not something an admin should discover after the fact.
 */
export const useProvisionDefaultInbox = ({
  authMethod,
  client = adminAgentsService,
  onProvisioned,
  refresh,
}: UseProvisionDefaultInboxParams) => {
  const { t } = useTranslation('admin');
  const [provisioning, setProvisioning] = useState(false);

  const provision = useCallback(() => {
    confirmModal({
      cancelText: t('primitives.dangerConfirm.cancel'),
      content: t('agentCatalog.defaultAgent.provision.description'),
      okText: t('agentCatalog.defaultAgent.provision.submit'),
      title: t('agentCatalog.defaultAgent.provision.title'),
      onOk: async () => {
        setProvisioning(true);
        let agentId: string | undefined;
        const committed = await runAdminMutation({
          authMethod,
          run: async () => {
            // The seeded name / prompt / opening message are written in the admin's own UI
            // language, so the takeover does not hand every member English copy by default.
            const created = await client.provisionDefaultInbox({
              locale: i18n.resolvedLanguage || i18n.language,
            });
            agentId = created.identity.id;
          },
        });
        setProvisioning(false);
        if (!committed || !agentId) return;

        try {
          // Both keys: the pinned card is the whole point of this write, and the table gained a row.
          await refresh();
        } catch {
          toast.warning(t('agentCatalog.recovery.refreshFailed'));
        }
        toast.success(t('agentCatalog.defaultAgent.provision.success'));
        await onProvisioned(agentId);
      },
    });
  }, [authMethod, client, onProvisioned, refresh, t]);

  return { provision, provisioning };
};
