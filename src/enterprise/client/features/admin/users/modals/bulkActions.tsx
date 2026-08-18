'use client';

import { Text } from '@lobehub/ui';
import { Checkbox, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type Dayjs } from 'dayjs';
import i18n from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminUsersBanInput,
  AdminUsersDeleteInput,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';

import { AUTO_REASON } from '../../audit/shared/auditReasonCodes';
import { getAdminUsersMutationErrorKey } from '../utils';
import {
  type BanMode,
  buildReplaceGlobalRolesPayload,
  getEligibleAssignableRoles,
} from './actions';
import { createBanExtra, createTypeToConfirmExtra, validateBanExtra } from './extras';
import { openReasonModal } from './openReasonModal';

const BULK_PREVIEW = 3;

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  option: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
  `,
  preview: css`
    color: ${cssVar.colorTextSecondary};
  `,
}));

const t = (key: string, opts?: Record<string, unknown>) =>
  String(i18n.t(key as never, { ns: 'admin', ...opts }));

export interface BulkUserTarget {
  currentRoles?: readonly string[];
  id: string;
  label: string;
}

export const formatBulkTargetLabel = (targets: readonly BulkUserTarget[]): string => {
  const names = targets.slice(0, BULK_PREVIEW).map((item) => item.label);
  if (targets.length <= BULK_PREVIEW) return names.join(', ');
  return `${names.join(', ')} ${t('users.modals.bulk.more', { count: targets.length - BULK_PREVIEW })}`;
};

export const skipSelfTargets = (
  targets: readonly BulkUserTarget[],
  actorUserId?: string,
): BulkUserTarget[] =>
  actorUserId ? targets.filter((item) => item.id !== actorUserId) : [...targets];

export interface BulkMutationResult {
  failed: { label: string; reason: string }[];
  succeeded: number;
}

export const runBulkUserMutations = async (params: {
  actorUserId?: string;
  items: readonly BulkUserTarget[];
  mutate: (item: BulkUserTarget) => Promise<unknown>;
}): Promise<BulkMutationResult> => {
  let succeeded = 0;
  const failed: BulkMutationResult['failed'] = [];

  for (const item of params.items) {
    if (params.actorUserId && item.id === params.actorUserId) continue;
    try {
      await params.mutate(item);
      succeeded += 1;
    } catch (error) {
      failed.push({
        label: item.label,
        reason: t(getAdminUsersMutationErrorKey(error)),
      });
    }
  }

  return { failed, succeeded };
};

export const toastBulkSummary = (result: BulkMutationResult) => {
  if (result.failed.length === 0) {
    toast.success(t('users.toast.bulkAllSucceeded', { count: result.succeeded }));
    return;
  }

  const detail = result.failed
    .slice(0, BULK_PREVIEW)
    .map((item) => t('users.toast.bulkFailureDetail', { label: item.label, reason: item.reason }))
    .join(' · ');

  toast.warning(
    `${t('users.toast.bulkSummary', {
      failed: result.failed.length,
      succeeded: result.succeeded,
    })}${detail ? ` — ${detail}` : ''}`,
  );
};

const BulkTargetPreview = memo<{ targets: readonly BulkUserTarget[] }>(({ targets }) => (
  <Text className={styles.preview}>
    {t('users.modals.bulk.preview', {
      count: targets.length,
      names: formatBulkTargetLabel(targets),
    })}
  </Text>
));
BulkTargetPreview.displayName = 'BulkTargetPreview';

export const openBulkBanModal = (params: {
  actorUserId?: string;
  authMethod?: AdminReauthAuthMethod;
  onConfirmEach: (input: AdminUsersBanInput) => Promise<unknown>;
  onDone?: () => void;
  targets: readonly BulkUserTarget[];
}) => {
  const targets = skipSelfTargets(params.targets, params.actorUserId);
  if (targets.length === 0) return;

  const banState = {
    expiresAt: null as Dayjs | null,
    mode: 'permanent' as BanMode,
  };

  const ControlledBan = createBanExtra(banState, {
    displayName: 'BulkControlledBan',
    prefix: <BulkTargetPreview targets={targets} />,
  });

  openReasonModal({
    authMethod: params.authMethod,
    // Optional, not required — see openBanUserModal: `banReason` is read back, an empty
    // submit records the stable code.
    autoReason: AUTO_REASON.ban,
    danger: true,
    description: t('users.modals.bulk.ban.desc', { count: targets.length }),
    impact: t('users.modals.ban.impact'),
    optionalReason: true,
    submitLabel: t('users.modals.bulk.ban.confirm'),
    targetLabel: formatBulkTargetLabel(targets),
    title: t('users.modals.bulk.ban.title'),
    extra: ({ locked, reportExtraChange }) => (
      <ControlledBan locked={locked} reportExtraChange={reportExtraChange} />
    ),
    validateExtra: () => validateBanExtra(banState),
    buildPayload: (reason) => {
      const payload: Omit<AdminUsersBanInput, 'userId'> = { reason };
      if (banState.mode === 'temporary' && banState.expiresAt) {
        payload.expiresAt = banState.expiresAt.toDate();
      }
      return payload;
    },
    onSubmit: async (payload) => {
      const base = payload as Omit<AdminUsersBanInput, 'userId'>;
      const result = await runBulkUserMutations({
        actorUserId: params.actorUserId,
        items: targets,
        mutate: (item) => params.onConfirmEach({ ...base, userId: item.id }),
      });
      toastBulkSummary(result);
      params.onDone?.();
    },
  });
};

export const openBulkUnbanModal = (params: {
  actorUserId?: string;
  authMethod?: AdminReauthAuthMethod;
  onConfirmEach: (input: AdminUsersUnbanInput) => Promise<unknown>;
  onDone?: () => void;
  targets: readonly BulkUserTarget[];
}) => {
  const targets = skipSelfTargets(params.targets, params.actorUserId);
  if (targets.length === 0) return;

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.unban,
    description: t('users.modals.bulk.unban.desc', { count: targets.length }),
    extra: <BulkTargetPreview targets={targets} />,
    impact: t('users.modals.unban.impact'),
    optionalReason: true,
    submitLabel: t('users.modals.bulk.unban.confirm'),
    targetLabel: formatBulkTargetLabel(targets),
    title: t('users.modals.bulk.unban.title'),
    buildPayload: (reason) => ({ reason }),
    onSubmit: async (payload) => {
      const { reason } = payload as { reason: string };
      const result = await runBulkUserMutations({
        actorUserId: params.actorUserId,
        items: targets,
        mutate: (item) => params.onConfirmEach({ reason, userId: item.id }),
      });
      toastBulkSummary(result);
      params.onDone?.();
    },
  });
};

export const openBulkDeleteModal = (params: {
  actorUserId?: string;
  authMethod?: AdminReauthAuthMethod;
  onConfirmEach: (input: AdminUsersDeleteInput) => Promise<unknown>;
  onDone?: () => void;
  targets: readonly BulkUserTarget[];
}) => {
  const targets = skipSelfTargets(params.targets, params.actorUserId);
  if (targets.length === 0) return;

  const confirmValue = String(targets.length);
  const deleteState = { confirmText: '' };

  const ControlledDeleteConfirm = createTypeToConfirmExtra(deleteState, {
    ariaLabelKey: 'users.modals.delete.typeConfirmLabel',
    displayName: 'BulkControlledDeleteConfirm',
    hintKey: 'users.modals.bulk.delete.typeConfirmHint',
    hintParams: { confirm: confirmValue, count: targets.length },
    placeholder: confirmValue,
    prefix: <BulkTargetPreview targets={targets} />,
  });

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.delete,
    danger: true,
    description: t('users.modals.bulk.delete.desc', { count: targets.length }),
    hideReason: true,
    impact: t('users.modals.delete.impact'),
    submitLabel: t('users.modals.bulk.delete.confirm'),
    targetLabel: formatBulkTargetLabel(targets),
    title: t('users.modals.bulk.delete.title'),
    extra: ({ locked, reportExtraChange }) => (
      <ControlledDeleteConfirm locked={locked} reportExtraChange={reportExtraChange} />
    ),
    validateExtra: () =>
      deleteState.confirmText.trim() === confirmValue
        ? null
        : 'users.modals.delete.typeConfirmMismatch',
    buildPayload: (reason) => ({ reason }),
    onSubmit: async (payload) => {
      const { reason } = payload as { reason: string };
      const result = await runBulkUserMutations({
        actorUserId: params.actorUserId,
        items: targets,
        mutate: (item) => params.onConfirmEach({ reason, userId: item.id }),
      });
      toastBulkSummary(result);
      params.onDone?.();
    },
  });
};

export const openBulkReplaceRolesModal = (params: {
  actorRoles: readonly { name: string }[];
  actorUserId?: string;
  authMethod?: AdminReauthAuthMethod;
  onConfirmEach: (input: AdminUsersReplaceGlobalRolesInput) => Promise<unknown>;
  onDone?: () => void;
  targets: readonly BulkUserTarget[];
}) => {
  const targets = skipSelfTargets(params.targets, params.actorUserId);
  if (targets.length === 0) return;

  const eligible = getEligibleAssignableRoles(params.actorRoles);
  const rolesState = { selected: new Set<string>() };

  const ControlledRoles = memo<{ locked: boolean; reportExtraChange: () => void }>(
    ({ locked, reportExtraChange }) => {
      const { t: tr } = useTranslation('admin');
      const [selected, setSelected] = useState(() => new Set<string>());
      return (
        <div className={styles.field}>
          <BulkTargetPreview targets={targets} />
          <Text>{tr('users.modals.roles.selectLabel')}</Text>
          {eligible.map((role) => (
            <label className={styles.option} key={role}>
              <Checkbox
                checked={selected.has(role)}
                disabled={locked}
                onChange={(checked) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(role);
                    else next.delete(role);
                    rolesState.selected = next;
                    return next;
                  });
                  reportExtraChange();
                }}
              />
              <span>{tr(`users.roles.${role}` as never)}</span>
            </label>
          ))}
        </div>
      );
    },
  );
  ControlledRoles.displayName = 'BulkControlledRoles';

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.roles,
    hideReason: true,
    submitLabel: t('users.modals.bulk.roles.confirm'),
    targetLabel: formatBulkTargetLabel(targets),
    title: t('users.modals.bulk.roles.title'),
    extra: ({ locked, reportExtraChange }) => (
      <ControlledRoles locked={locked} reportExtraChange={reportExtraChange} />
    ),
    validateExtra: () => {
      if (
        rolesState.selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) &&
        !eligible.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)
      ) {
        return 'users.modals.roles.superAdminForbidden';
      }
      return null;
    },
    buildPayload: (reason) => ({ reason, selected: [...rolesState.selected] }),
    onSubmit: async (payload) => {
      const { reason, selected } = payload as { reason: string; selected: string[] };
      const result = await runBulkUserMutations({
        actorUserId: params.actorUserId,
        items: targets,
        mutate: (item) =>
          params.onConfirmEach(
            buildReplaceGlobalRolesPayload({
              currentRoles: item.currentRoles ?? [],
              eligibleRoleNames: eligible,
              reason,
              selectedRoleNames: selected,
              userId: item.id,
            }),
          ),
      });
      toastBulkSummary(result);
      params.onDone?.();
    },
  });
};
