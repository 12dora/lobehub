'use client';

import { Text } from '@lobehub/ui';
import { Checkbox, toast } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersRevokeSessionsInput } from '@/enterprise/client/services/adminUsers';

import { AUTO_REASON } from '../../audit/shared/auditReasonCodes';
import { actionExtraStyles as styles } from './actionExtraStyles';
import { t } from './actionI18n';
import { openReasonModal } from './openReasonModal';

// ── Revoke ──────────────────────────────────────────────────────────────────

const RevokeSelfExtra = memo<{
  includeCurrent: boolean;
  locked: boolean;
  onIncludeCurrentChange: (v: boolean) => void;
}>(({ includeCurrent, locked, onIncludeCurrentChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <Text className={styles.hint}>{tr('users.modals.revoke.impactSelf')}</Text>
      <label className={styles.option}>
        <Checkbox
          checked={includeCurrent}
          disabled={locked}
          onChange={(checked) => onIncludeCurrentChange(Boolean(checked))}
        />
        <span>{tr('users.modals.revoke.includeCurrent')}</span>
      </label>
      {includeCurrent ? (
        <Text type="danger">{tr('users.modals.revoke.includeCurrentWarning')}</Text>
      ) : null}
    </div>
  );
});
RevokeSelfExtra.displayName = 'RevokeSelfExtra';

/** Revoke every session (confirm-only). Self keeps the current session unless opted in. */
export const openRevokeSessionsModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  isSelf: boolean;
  onConfirm: (input: AdminUsersRevokeSessionsInput) => Promise<unknown>;
  targetLabel: string;
  userId: string;
}) => {
  // Updated only from onChange handlers — never during render.
  const revokeState = { includeCurrent: false };

  const ControlledRevoke = memo<{ locked: boolean }>(({ locked }) => {
    const [inc, setInc] = useState(false);
    return (
      <RevokeSelfExtra
        includeCurrent={inc}
        locked={locked}
        onIncludeCurrentChange={(next) => {
          setInc(next);
          revokeState.includeCurrent = next;
        }}
      />
    );
  });
  ControlledRevoke.displayName = 'ControlledRevoke';

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.revokeAll,
    danger: true,
    hideReason: true,
    impact: params.isSelf
      ? t('users.modals.revoke.impactSelfDefault')
      : t('users.modals.revoke.impactOther'),
    submitLabel: t('users.modals.revoke.confirmAll'),
    targetLabel: params.targetLabel,
    title: t('users.modals.revoke.titleAll'),
    extra: params.isSelf ? ({ locked }) => <ControlledRevoke locked={locked} /> : undefined,
    buildPayload: (reason) => ({
      includeCurrent: params.isSelf ? revokeState.includeCurrent : true,
      reason,
      userId: params.userId,
    }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersRevokeSessionsInput);
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};

/** Revoke a single session by id (confirm-only, targeted). */
export const openRevokeSingleSessionModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  isSelf?: boolean;
  onConfirm: (input: AdminUsersRevokeSessionsInput) => Promise<unknown>;
  sessionId: string;
  targetLabel: string;
  userId: string;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.revokeOne,
    danger: true,
    hideReason: true,
    impact: params.isSelf
      ? t('users.modals.revoke.impactSingleSelf')
      : t('users.modals.revoke.impactSingle'),
    submitLabel: t('users.modals.revoke.confirmSingle'),
    targetLabel: params.targetLabel,
    title: t('users.modals.revoke.titleSingle'),
    buildPayload: (reason) => ({
      reason,
      sessionIds: [params.sessionId],
      userId: params.userId,
    }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersRevokeSessionsInput);
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};
