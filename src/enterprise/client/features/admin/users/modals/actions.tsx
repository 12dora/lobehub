'use client';

import { DatePicker, Text } from '@lobehub/ui';
import { Checkbox, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs, { type Dayjs } from 'dayjs';
import i18n from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminUsersBanInput,
  AdminUsersDeleteInput,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersRevokeSessionsInput,
  AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';

import { openReasonModal } from './openReasonModal';

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  hint: css`
    color: ${cssVar.colorTextSecondary};
  `,
  option: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
  `,
  roleBlock: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-block: 4px;
  `,
  roleDesc: css`
    margin-inline-start: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const ALL_ASSIGNABLE: PlatformSystemRoleName[] = [
  PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  PLATFORM_SYSTEM_ROLES.AUDITOR,
  PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
];

const t = (key: string, opts?: Record<string, unknown>) =>
  String(i18n.t(key as never, { ns: 'admin', ...opts }));

/**
 * Fixed audit reasons for confirm-only actions (no free-form reason field).
 * The server still bounds these as a non-empty reason — stable, non-localized strings
 * keep the audit trail consistent across locales.
 */
const AUTO_REASON = {
  delete: 'User hard-deleted from admin console',
  revokeAll: 'All sessions revoked from admin console',
  revokeOne: 'Session revoked from admin console',
  roleRevoke: 'Global role revoked from admin console',
  roles: 'Global roles updated from admin console',
} as const;

export const getEligibleAssignableRoles = (
  actorRoles: readonly { name: string }[],
): PlatformSystemRoleName[] => {
  const isSuper = actorRoles.some((r) => r.name === PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  if (isSuper) return [...ALL_ASSIGNABLE];
  return ALL_ASSIGNABLE.filter((r) => r !== PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
};

// ── Ban ─────────────────────────────────────────────────────────────────────

type BanMode = 'permanent' | 'temporary';

const BanExtraFields = memo<{
  expiresAt: Dayjs | null;
  locked: boolean;
  mode: BanMode;
  onExpiresAtChange: (v: Dayjs | null) => void;
  onModeChange: (mode: BanMode) => void;
}>(({ mode, expiresAt, locked, onModeChange, onExpiresAtChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <label className={styles.option}>
        <Checkbox
          checked={mode === 'permanent'}
          disabled={locked}
          onChange={(checked) => {
            if (checked) onModeChange('permanent');
          }}
        />
        <span>{tr('users.modals.ban.permanent')}</span>
      </label>
      <label className={styles.option}>
        <Checkbox
          checked={mode === 'temporary'}
          disabled={locked}
          onChange={(checked) => {
            if (checked) onModeChange('temporary');
          }}
        />
        <span>{tr('users.modals.ban.temporary')}</span>
      </label>
      {mode === 'temporary' ? (
        <DatePicker
          showTime
          aria-label={tr('users.modals.ban.expiryLabel')}
          disabled={locked}
          disabledDate={(d) => d.isBefore(dayjs())}
          value={expiresAt}
          onChange={(v) => onExpiresAtChange(v as Dayjs | null)}
        />
      ) : null}
    </div>
  );
});
BanExtraFields.displayName = 'BanExtraFields';

export const openBanUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: Omit<AdminUsersBanInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  // Updated only from onChange handlers — never during render.
  const banState = {
    expiresAt: null as Dayjs | null,
    mode: 'permanent' as BanMode,
  };

  const ControlledBan = memo<{ locked: boolean }>(({ locked }) => {
    const [m, setM] = useState<BanMode>('permanent');
    const [exp, setExp] = useState<Dayjs | null>(null);
    return (
      <BanExtraFields
        expiresAt={exp}
        locked={locked}
        mode={m}
        onExpiresAtChange={(next) => {
          setExp(next);
          banState.expiresAt = next;
        }}
        onModeChange={(next) => {
          setM(next);
          banState.mode = next;
          if (next === 'permanent') {
            setExp(null);
            banState.expiresAt = null;
          }
        }}
      />
    );
  });
  ControlledBan.displayName = 'ControlledBan';

  openReasonModal({
    authMethod: params.authMethod,
    danger: true,
    description: t('users.modals.ban.desc'),
    impact: t('users.modals.ban.impact'),
    submitLabel: t('users.modals.ban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.ban.title'),
    extra: ({ locked }) => <ControlledBan locked={locked} />,
    validateExtra: () => {
      if (banState.mode === 'permanent') return null;
      if (!banState.expiresAt) return 'users.modals.ban.expiryRequired';
      if (!banState.expiresAt.isAfter(dayjs())) return 'users.modals.ban.expiryFuture';
      return null;
    },
    buildPayload: (reason) => {
      const payload: Omit<AdminUsersBanInput, 'userId'> = { reason };
      if (banState.mode === 'temporary' && banState.expiresAt) {
        payload.expiresAt = banState.expiresAt.toDate();
      }
      return payload;
    },
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersBanInput, 'userId'>);
      toast.success(t('users.toast.banSuccess'));
    },
  });
};

// ── Unban ───────────────────────────────────────────────────────────────────

export const openUnbanUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: Omit<AdminUsersUnbanInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    description: t('users.modals.unban.desc'),
    impact: t('users.modals.unban.impact'),
    submitLabel: t('users.modals.unban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.unban.title'),
    buildPayload: (reason) => ({ reason }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersUnbanInput, 'userId'>);
      toast.success(t('users.toast.unbanSuccess'));
    },
  });
};

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
  onConfirm: (input: Omit<AdminUsersRevokeSessionsInput, 'userId'>) => Promise<void>;
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
    }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersRevokeSessionsInput, 'userId'>);
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};

/** Revoke a single session by id (confirm-only, targeted). */
export const openRevokeSingleSessionModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  isSelf?: boolean;
  onConfirm: (input: Omit<AdminUsersRevokeSessionsInput, 'userId'>) => Promise<void>;
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
    buildPayload: (reason) => ({ reason, sessionIds: [params.sessionId] }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersRevokeSessionsInput, 'userId'>);
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};

// ── Roles ───────────────────────────────────────────────────────────────────

const RolesExtra = memo<{
  eligible: PlatformSystemRoleName[];
  expiresAt: Dayjs | null;
  locked: boolean;
  onExpiresAtChange: (v: Dayjs | null) => void;
  onToggle: (role: PlatformSystemRoleName, checked: boolean) => void;
  selected: ReadonlySet<string>;
}>(({ eligible, selected, expiresAt, locked, onToggle, onExpiresAtChange }) => {
  const { t: tr } = useTranslation('admin');
  const hasSuper = selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  return (
    <div className={styles.field}>
      <Text>{tr('users.modals.roles.selectLabel')}</Text>
      {eligible.map((role) => (
        <div className={styles.roleBlock} key={role}>
          <label className={styles.option}>
            <Checkbox
              checked={selected.has(role)}
              disabled={locked}
              onChange={(checked) => onToggle(role, Boolean(checked))}
            />
            <span>{tr(`users.roles.${role}` as never)}</span>
          </label>
          <Text className={styles.roleDesc}>
            {tr(`users.roles.desc.${role}` as never)}
            {' · '}
            {tr(`users.roles.impact.${role}` as never)}
          </Text>
        </div>
      ))}
      {hasSuper ? (
        <Text className={styles.hint}>{tr('users.modals.roles.superAdminNoExpiry')}</Text>
      ) : (
        <>
          <Text>{tr('users.modals.roles.expiryOptional')}</Text>
          <DatePicker
            allowClear
            showTime
            aria-label={tr('users.modals.roles.expiryOptional')}
            disabled={locked}
            disabledDate={(d) => d.isBefore(dayjs())}
            value={expiresAt}
            onChange={(v) => onExpiresAtChange(v as Dayjs | null)}
          />
        </>
      )}
    </div>
  );
});
RolesExtra.displayName = 'RolesExtra';

export const openReplaceRolesModal = (params: {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod;
  currentRoles: string[];
  onConfirm: (input: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  const eligible = getEligibleAssignableRoles(params.actorRoles);
  const initial = new Set(
    params.currentRoles.filter((r) => (eligible as readonly string[]).includes(r)),
  );

  // Updated only from onChange handlers — never during render.
  const rolesState = {
    expiresAt: null as Dayjs | null,
    selected: new Set(initial),
  };

  const ControlledRoles = memo<{ locked: boolean }>(({ locked }) => {
    const [sel, setSel] = useState(() => new Set(initial));
    const [exp, setExp] = useState<Dayjs | null>(null);
    return (
      <RolesExtra
        eligible={eligible}
        expiresAt={exp}
        locked={locked}
        selected={sel}
        onExpiresAtChange={(next) => {
          setExp(next);
          rolesState.expiresAt = next;
        }}
        onToggle={(role, checked) => {
          setSel((prev) => {
            const next = new Set(prev);
            if (checked) next.add(role);
            else next.delete(role);
            // Super admin cannot be temporary — clear expiry when selecting super.
            if (role === PLATFORM_SYSTEM_ROLES.SUPER_ADMIN && checked) {
              setExp(null);
              rolesState.expiresAt = null;
            }
            rolesState.selected = next;
            return next;
          });
        }}
      />
    );
  });
  ControlledRoles.displayName = 'ControlledRoles';

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.roles,
    hideReason: true,
    submitLabel: t('users.modals.roles.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.roles.title'),
    extra: ({ locked }) => <ControlledRoles locked={locked} />,
    validateExtra: () => {
      if (
        rolesState.selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) &&
        !eligible.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)
      ) {
        return 'users.modals.roles.superAdminForbidden';
      }
      if (rolesState.selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) && rolesState.expiresAt) {
        return 'users.modals.roles.superAdminNoExpiry';
      }
      if (rolesState.expiresAt && !rolesState.expiresAt.isAfter(dayjs())) {
        return 'users.modals.roles.expiryFuture';
      }
      return null;
    },
    buildPayload: (reason) => {
      const roleNames = [...rolesState.selected].filter((r) =>
        (eligible as readonly string[]).includes(r),
      ) as PlatformSystemRoleName[];
      const payload: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'> = {
        reason,
        roleNames,
      };
      // Never pair super_admin with finite expiry.
      if (rolesState.expiresAt && !roleNames.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)) {
        payload.expiresAt = rolesState.expiresAt.toDate();
      }
      return payload;
    },
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>);
      toast.success(t('users.toast.rolesSuccess'));
    },
  });
};

/**
 * Revoke a single global role (confirm-only). Implemented as a full replace with the
 * revoked role removed — the server keeps its last-super-admin protection.
 */
export const openRevokeRoleModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>) => Promise<void>;
  remainingRoleNames: PlatformSystemRoleName[];
  revokedRoleLabel: string;
  targetLabel: string;
  userId: string;
}) => {
  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.roleRevoke,
    danger: true,
    hideReason: true,
    impact: t('users.modals.revokeRole.impact', { role: params.revokedRoleLabel }),
    submitLabel: t('users.modals.revokeRole.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.revokeRole.title'),
    // Preserve the remaining grants untouched (keep their expiry) — only the revoked
    // role is removed; never silently make a temporary grant permanent.
    buildPayload: (reason) => ({
      preserveRoleNames: params.remainingRoleNames,
      reason,
      roleNames: params.remainingRoleNames,
    }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>);
      toast.success(t('users.toast.roleRevokeSuccess'));
    },
  });
};

/** Irreversible hard delete of a user and all owned data (confirm-only). */
export const openDeleteUserModal = (params: {
  authMethod?: AdminReauthAuthMethod;
  onConfirm: (input: Omit<AdminUsersDeleteInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
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
    buildPayload: (reason) => ({ reason }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as Omit<AdminUsersDeleteInput, 'userId'>);
      toast.success(t('users.toast.deleteSuccess'));
    },
  });
};
