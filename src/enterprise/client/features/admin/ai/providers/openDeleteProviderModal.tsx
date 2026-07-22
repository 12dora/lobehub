'use client';

import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';

import type { AdminAiProviderDeleteInput } from '@/enterprise/client/features/admin/ai/types';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { openReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';

const t = (key: string) => String(i18n.t(key as never, { ns: 'admin' }));

/**
 * Stable, non-localized audit reason for the confirm-only hard delete. The server still bounds
 * it as a non-empty reason; keeping it locale-independent keeps the audit trail consistent.
 */
const DELETE_REASON = 'Provider hard-deleted from admin console';

/**
 * Irreversible hard delete of a catalog provider (and all its models, secrets, revisions).
 * Reuses the shared reason modal (confirm-only + reauth). `onDeleted` runs after a successful
 * commit — it must not throw (swallow refresh errors) or the modal will surface a false failure.
 */
export const openDeleteProviderModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  displayName: string;
  onDeleted: () => void | Promise<void>;
  providerId: string;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    autoReason: DELETE_REASON,
    danger: true,
    description: t('aiCatalog.actions.delete.desc'),
    hideReason: true,
    impact: t('aiCatalog.actions.delete.impact'),
    submitLabel: t('aiCatalog.actions.delete.label'),
    targetLabel: params.displayName,
    title: t('aiCatalog.actions.delete.title'),
    buildPayload: (reason): AdminAiProviderDeleteInput => ({ id: params.providerId, reason }),
    onSubmit: async (payload) => {
      await adminAiCatalogService.deleteProvider(payload as AdminAiProviderDeleteInput);
      toast.success(t('aiCatalog.toast.providerDeleted'));
      await params.onDeleted();
    },
  });
};
