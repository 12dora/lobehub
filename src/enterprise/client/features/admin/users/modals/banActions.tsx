'use client';

import { toast } from '@lobehub/ui/base-ui';
import { type Dayjs } from 'dayjs';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminUsersBanInput,
  AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';

import { AUTO_REASON } from '../../audit/shared/auditReasonCodes';
import { t } from './actionI18n';
import { type BanMode, createBanExtra, validateBanExtra } from './extras';
import { openReasonModal } from './openReasonModal';

// ── Ban ─────────────────────────────────────────────────────────────────────

export const openBanUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: AdminUsersBanInput) => Promise<unknown>;
  targetLabel: string;
  userId: string;
}) => {
  // Updated only from onChange handlers — never during render.
  const banState = {
    expiresAt: null as Dayjs | null,
    mode: 'permanent' as BanMode,
  };

  const ControlledBan = createBanExtra(banState, { displayName: 'ControlledBan' });

  openReasonModal({
    authMethod: params.authMethod,
    // Kept as a field, not a gate: `user.banReason` is surfaced later, so the operator may
    // explain — but an empty submit records the stable code instead of blocking.
    autoReason: AUTO_REASON.ban,
    danger: true,
    description: t('users.modals.ban.desc'),
    impact: t('users.modals.ban.impact'),
    optionalReason: true,
    submitLabel: t('users.modals.ban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.ban.title'),
    extra: ({ locked, reportExtraChange }) => (
      <ControlledBan locked={locked} reportExtraChange={reportExtraChange} />
    ),
    validateExtra: () => validateBanExtra(banState),
    buildPayload: (reason) => {
      const payload: AdminUsersBanInput = { reason, userId: params.userId };
      if (banState.mode === 'temporary' && banState.expiresAt) {
        payload.expiresAt = banState.expiresAt.toDate();
      }
      return payload;
    },
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersBanInput);
      toast.success(t('users.toast.banSuccess'));
    },
  });
};

// ── Unban ───────────────────────────────────────────────────────────────────

export const openUnbanUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: AdminUsersUnbanInput) => Promise<unknown>;
  targetLabel: string;
  userId: string;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.unban,
    description: t('users.modals.unban.desc'),
    impact: t('users.modals.unban.impact'),
    optionalReason: true,
    submitLabel: t('users.modals.unban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.unban.title'),
    buildPayload: (reason) => ({ reason, userId: params.userId }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersUnbanInput);
      toast.success(t('users.toast.unbanSuccess'));
    },
  });
};
