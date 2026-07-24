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
 * assistants are refused server-side.
 *
 * Full identity CAS (`expectedDraftToken` + `expectedRevision`) is required so concurrent
 * version/assignment/draft mutations cannot be wiped by a stale list row. `onDeleted` runs after
 * a successful commit; refresh failures must not convert the committed delete into a false
 * mutation failure (caller should catch and surface a retryable refresh warning).
 */
export const openDeleteAgentModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  agentId: string;
  displayName: string;
  expectedDraftToken: string;
  expectedRevision: number;
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
    buildPayload: (reason): AdminPlatformAgentDeleteInput => ({
      agentId: params.agentId,
      expectedDraftToken: params.expectedDraftToken,
      expectedRevision: params.expectedRevision,
      reason,
    }),
    onSubmit: async (payload) => {
      await adminAgentsService.delete(payload as AdminPlatformAgentDeleteInput);
      toast.success(t('agentCatalog.toast.deleted'));
      try {
        await params.onDeleted();
      } catch {
        // Deletion already committed — never surface refresh failure as a mutation failure.
        toast.error(t('agentCatalog.recovery.refreshFailed'));
      }
    },
  });
};
