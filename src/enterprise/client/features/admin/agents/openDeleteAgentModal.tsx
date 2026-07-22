'use client';

import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type { AdminPlatformAgentDeleteInput } from './types';

const t = (key: string) => String(i18n.t(key as never, { ns: 'admin' }));

/**
 * Stable, non-localized audit reason for the confirm-only hard delete. The server still bounds
 * it as a non-empty reason; keeping it locale-independent keeps the audit trail consistent.
 */
const DELETE_REASON = 'Platform assistant hard-deleted from admin console';

/**
 * Irreversible hard delete of a platform assistant (and all its versions, assignments,
 * materializations). Reuses the shared reason modal (confirm-only + reauth). Default / system
 * assistants are refused server-side. `onDeleted` runs after a successful commit and must not
 * throw (swallow refresh errors) or the modal will surface a false failure.
 */
export const openDeleteAgentModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  agentId: string;
  displayName: string;
  onDeleted: () => void | Promise<void>;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    autoReason: DELETE_REASON,
    danger: true,
    description: t('agentCatalog.delete.description'),
    hideReason: true,
    impact: t('agentCatalog.delete.impact'),
    submitLabel: t('agentCatalog.delete.submit'),
    targetLabel: params.displayName,
    title: t('agentCatalog.delete.title'),
    buildPayload: (reason): AdminPlatformAgentDeleteInput => ({ agentId: params.agentId, reason }),
    onSubmit: async (payload) => {
      await adminAgentsService.delete(payload as AdminPlatformAgentDeleteInput);
      toast.success(t('agentCatalog.toast.deleted'));
      await params.onDeleted();
    },
  });
};
