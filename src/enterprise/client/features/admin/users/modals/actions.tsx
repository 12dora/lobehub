'use client';

import { Text } from '@lobehub/ui';
import { Checkbox, toast } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs, { type Dayjs } from 'dayjs';
import i18n from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PLATFORM_ROLE_DESCRIPTIONS,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_SYSTEM_ROLES,
  type PlatformSystemRoleName,
} from '@/const/platform/roles';
import type {
  AdminUsersBanInput,
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

/** Roles assignable via replaceGlobalRoles (server mirror). */
const ALL_ASSIGNABLE: PlatformSystemRoleName[] = [
  PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  PLATFORM_SYSTEM_ROLES.AUDITOR,
  PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
];

const t = (key: string) => String(i18n.t(key as never, { ns: 'admin' }));

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
  mode: BanMode;
  onExpiresAtChange: (v: Dayjs | null) => void;
  onModeChange: (mode: BanMode) => void;
}>(({ mode, expiresAt, onModeChange, onExpiresAtChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <label className={styles.option}>
        <Checkbox
          checked={mode === 'permanent'}
          onChange={(checked) => {
            if (checked) onModeChange('permanent');
          }}
        />
        <span>{tr('users.modals.ban.permanent')}</span>
      </label>
      <label className={styles.option}>
        <Checkbox
          checked={mode === 'temporary'}
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
          disabledDate={(d) => d.isBefore(dayjs())}
          value={expiresAt}
          onChange={(v) => onExpiresAtChange(v)}
        />
      ) : null}
    </div>
  );
});
BanExtraFields.displayName = 'BanExtraFields';

export const openBanUserModal = (params: {
  onConfirm: (input: Omit<AdminUsersBanInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  // Controlled state lives inside a small wrapper mounted as modal content extra.
  let mode: BanMode = 'permanent';
  let expiresAt: Dayjs | null = null;

  const ControlledBan = memo(() => {
    const [m, setM] = useState<BanMode>('permanent');
    const [exp, setExp] = useState<Dayjs | null>(null);
    mode = m;
    expiresAt = exp;
    return (
      <BanExtraFields
        expiresAt={exp}
        mode={m}
        onExpiresAtChange={setExp}
        onModeChange={(next) => {
          setM(next);
          if (next === 'permanent') setExp(null);
        }}
      />
    );
  });
  ControlledBan.displayName = 'ControlledBan';

  openReasonModal({
    danger: true,
    description: t('users.modals.ban.desc'),
    impact: t('users.modals.ban.impact'),
    submitLabel: t('users.modals.ban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.ban.title'),
    extra: <ControlledBan />,
    validateExtra: () => {
      if (mode === 'permanent') return null;
      if (!expiresAt) return 'users.modals.ban.expiryRequired';
      if (!expiresAt.isAfter(dayjs())) return 'users.modals.ban.expiryFuture';
      return null;
    },
    onSubmit: async (reason) => {
      const payload: Omit<AdminUsersBanInput, 'userId'> = { reason };
      if (mode === 'temporary' && expiresAt) {
        payload.expiresAt = expiresAt.toDate();
      }
      await params.onConfirm(payload);
      toast.success(t('users.toast.banSuccess'));
    },
  });
};

// ── Unban ───────────────────────────────────────────────────────────────────

export const openUnbanUserModal = (params: {
  onConfirm: (input: Omit<AdminUsersUnbanInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  openReasonModal({
    description: t('users.modals.unban.desc'),
    impact: t('users.modals.unban.impact'),
    submitLabel: t('users.modals.unban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.unban.title'),
    onSubmit: async (reason) => {
      await params.onConfirm({ reason });
      toast.success(t('users.toast.unbanSuccess'));
    },
  });
};

// ── Revoke ──────────────────────────────────────────────────────────────────

const RevokeSelfExtra = memo<{
  includeCurrent: boolean;
  onIncludeCurrentChange: (v: boolean) => void;
}>(({ includeCurrent, onIncludeCurrentChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <Text className={styles.hint}>{tr('users.modals.revoke.impactSelf')}</Text>
      <label className={styles.option}>
        <Checkbox
          checked={includeCurrent}
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

export const openRevokeSessionsModal = (params: {
  isSelf: boolean;
  onConfirm: (input: Omit<AdminUsersRevokeSessionsInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  let includeCurrent = false;

  const ControlledRevoke = memo(() => {
    const [inc, setInc] = useState(false);
    includeCurrent = inc;
    return <RevokeSelfExtra includeCurrent={inc} onIncludeCurrentChange={setInc} />;
  });
  ControlledRevoke.displayName = 'ControlledRevoke';

  openReasonModal({
    danger: true,
    description: t('users.modals.revoke.desc'),
    impact: params.isSelf
      ? t('users.modals.revoke.impactSelfDefault')
      : t('users.modals.revoke.impactOther'),
    submitLabel: t('users.modals.revoke.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.revoke.title'),
    extra: params.isSelf ? <ControlledRevoke /> : undefined,
    onSubmit: async (reason) => {
      await params.onConfirm({
        // Self: default retain current (includeCurrent=false); other: revoke all.
        includeCurrent: params.isSelf ? includeCurrent : true,
        reason,
      });
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};

// ── Roles ───────────────────────────────────────────────────────────────────

const RolesExtra = memo<{
  eligible: PlatformSystemRoleName[];
  expiresAt: Dayjs | null;
  onExpiresAtChange: (v: Dayjs | null) => void;
  onToggle: (role: PlatformSystemRoleName, checked: boolean) => void;
  selected: ReadonlySet<string>;
}>(({ eligible, selected, expiresAt, onToggle, onExpiresAtChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <Text>{tr('users.modals.roles.selectLabel')}</Text>
      {eligible.map((role) => (
        <div className={styles.roleBlock} key={role}>
          <label className={styles.option}>
            <Checkbox
              checked={selected.has(role)}
              onChange={(checked) => onToggle(role, Boolean(checked))}
            />
            <span>{tr(`users.roles.${role}` as never)}</span>
          </label>
          <Text className={styles.roleDesc}>
            {PLATFORM_ROLE_DESCRIPTIONS[role]}
            {' · '}
            {tr('users.modals.roles.permissionCount', {
              count: PLATFORM_ROLE_PERMISSIONS[role].length,
            })}
          </Text>
        </div>
      ))}
      <Text className={styles.hint}>{tr('users.modals.roles.lastSuperNote')}</Text>
      <Text>{tr('users.modals.roles.expiryOptional')}</Text>
      <DatePicker
        allowClear
        showTime
        aria-label={tr('users.modals.roles.expiryOptional')}
        disabledDate={(d) => d.isBefore(dayjs())}
        value={expiresAt}
        onChange={(v) => onExpiresAtChange(v)}
      />
    </div>
  );
});
RolesExtra.displayName = 'RolesExtra';

export const openReplaceRolesModal = (params: {
  actorRoles: readonly { name: string }[];
  currentRoles: string[];
  onConfirm: (input: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  const eligible = getEligibleAssignableRoles(params.actorRoles);
  const initial = new Set(
    params.currentRoles.filter((r) => (eligible as readonly string[]).includes(r)),
  );

  let selected = new Set(initial);
  let expiresAt: Dayjs | null = null;

  const ControlledRoles = memo(() => {
    const [sel, setSel] = useState(() => new Set(initial));
    const [exp, setExp] = useState<Dayjs | null>(null);
    selected = sel;
    expiresAt = exp;
    return (
      <RolesExtra
        eligible={eligible}
        expiresAt={exp}
        selected={sel}
        onExpiresAtChange={setExp}
        onToggle={(role, checked) => {
          setSel((prev) => {
            const next = new Set(prev);
            if (checked) next.add(role);
            else next.delete(role);
            return next;
          });
        }}
      />
    );
  });
  ControlledRoles.displayName = 'ControlledRoles';

  openReasonModal({
    description: t('users.modals.roles.desc'),
    impact: t('users.modals.roles.impact'),
    submitLabel: t('users.modals.roles.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.roles.title'),
    extra: <ControlledRoles />,
    validateExtra: () => {
      if (expiresAt && !expiresAt.isAfter(dayjs())) {
        return 'users.modals.roles.expiryFuture';
      }
      // Reject if super_admin slipped in without eligibility
      if (
        selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) &&
        !eligible.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)
      ) {
        return 'users.modals.roles.superAdminForbidden';
      }
      return null;
    },
    onSubmit: async (reason) => {
      const roleNames = [...selected].filter((r) =>
        (eligible as readonly string[]).includes(r),
      ) as PlatformSystemRoleName[];
      const payload: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'> = {
        reason,
        roleNames,
      };
      if (expiresAt) {
        payload.expiresAt = expiresAt.toDate();
      }
      await params.onConfirm(payload);
      toast.success(t('users.toast.rolesSuccess'));
    },
  });
};
