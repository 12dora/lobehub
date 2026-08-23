'use client';

import { toast } from '@lobehub/ui/base-ui';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersDeleteInput } from '@/enterprise/client/services/adminUsers';

import { AUTO_REASON } from '../../audit/shared/auditReasonCodes';
import { t } from './actionI18n';
import { validateHardDeleteConfirm } from './deleteConfirm';
import { createTypeToConfirmExtra } from './extras';
import { openReasonModal } from './openReasonModal';

/** Irreversible hard delete of a user and all owned data (confirm-only + type-to-confirm). */
export const openDeleteUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: AdminUsersDeleteInput) => Promise<unknown>;
  targetLabel: string;
  userId: string;
}) => {
  // Updated only from onChange — requires exact match of the displayed target label.
  const deleteState = { confirmText: '' };

  const ControlledDeleteConfirm = createTypeToConfirmExtra(deleteState, {
    ariaLabelKey: 'users.modals.delete.typeConfirmLabel',
    displayName: 'ControlledDeleteConfirm',
    hintKey: 'users.modals.delete.typeConfirmHint',
    hintParams: { target: params.targetLabel },
    placeholder: params.targetLabel,
  });

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.delete,
    danger: true,
    description: t('users.modals.delete.desc'),
    hideReason: true,
    impact: t('users.modals.delete.impact'),
    submitLabel: t('users.modals.delete.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.delete.title'),
    extra: ({ locked, reportExtraChange }) => (
      <ControlledDeleteConfirm locked={locked} reportExtraChange={reportExtraChange} />
    ),
    validateExtra: () => validateHardDeleteConfirm(deleteState.confirmText, params.targetLabel),
    buildPayload: (reason) => ({ reason, userId: params.userId }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersDeleteInput);
      toast.success(t('users.toast.deleteSuccess'));
    },
  });
};
