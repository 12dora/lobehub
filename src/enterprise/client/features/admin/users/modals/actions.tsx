'use client';

import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import type {
  AdminUsersBanInput,
  AdminUsersReplaceGlobalRolesInput,
  AdminUsersRevokeSessionsInput,
  AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';

import { openReasonModal } from './openReasonModal';

/** Assignable global role packages (mirrors server ADMIN_USER_ASSIGNABLE_ROLE_NAMES). */
const ASSIGNABLE_ROLES = [
  PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  PLATFORM_SYSTEM_ROLES.AUDITOR,
  PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
] as const;

type AssignableRoleName = (typeof ASSIGNABLE_ROLES)[number];

const t = (key: string) => String(i18n.t(key as never, { ns: 'admin' }));

export const openBanUserModal = (params: {
  onConfirm: (input: Omit<AdminUsersBanInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  let permanent = true;
  let expiresAtLocal = '';

  openReasonModal({
    danger: true,
    description: t('users.modals.ban.desc'),
    impact: t('users.modals.ban.impact'),
    submitLabel: t('users.modals.ban.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.ban.title'),
    validateExtra: () => {
      if (permanent) return null;
      if (!expiresAtLocal) return 'users.modals.ban.expiryRequired';
      const d = new Date(expiresAtLocal);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        return 'users.modals.ban.expiryFuture';
      }
      return null;
    },
    extra: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            defaultChecked
            name="ban-permanent"
            type="radio"
            onChange={() => {
              permanent = true;
              expiresAtLocal = '';
            }}
          />
          <span>{t('users.modals.ban.permanent')}</span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            name="ban-permanent"
            type="radio"
            onChange={() => {
              permanent = false;
            }}
          />
          <span>{t('users.modals.ban.temporary')}</span>
        </label>
        <input
          aria-label={t('users.modals.ban.expiryLabel')}
          type="datetime-local"
          onChange={(e) => {
            permanent = false;
            expiresAtLocal = e.target.value;
          }}
        />
      </div>
    ),
    onSubmit: async (reason) => {
      const payload: Omit<AdminUsersBanInput, 'userId'> = { reason };
      if (!permanent && expiresAtLocal) {
        payload.expiresAt = new Date(expiresAtLocal);
      }
      await params.onConfirm(payload);
      toast.success(t('users.toast.banSuccess'));
    },
  });
};

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

export const openRevokeSessionsModal = (params: {
  onConfirm: (input: Omit<AdminUsersRevokeSessionsInput, 'userId'>) => Promise<void>;
  selfTarget: boolean;
  targetLabel: string;
  userId: string;
}) => {
  let includeCurrent = false;

  openReasonModal({
    danger: true,
    description: t('users.modals.revoke.desc'),
    impact: params.selfTarget
      ? t('users.modals.revoke.impactSelf')
      : t('users.modals.revoke.impactOther'),
    submitLabel: t('users.modals.revoke.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.revoke.title'),
    extra: params.selfTarget ? (
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          onChange={(e) => {
            includeCurrent = e.target.checked;
          }}
        />
        <span>{t('users.modals.revoke.includeCurrent')}</span>
      </label>
    ) : undefined,
    onSubmit: async (reason) => {
      await params.onConfirm({
        includeCurrent: params.selfTarget ? includeCurrent : true,
        reason,
      });
      toast.success(t('users.toast.revokeSuccess'));
    },
  });
};

export const openReplaceRolesModal = (params: {
  currentRoles: string[];
  onConfirm: (input: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'>) => Promise<void>;
  targetLabel: string;
  userId: string;
}) => {
  const selected = new Set<string>(
    params.currentRoles.filter((r) => (ASSIGNABLE_ROLES as readonly string[]).includes(r)),
  );
  let expiresAtLocal = '';

  openReasonModal({
    description: t('users.modals.roles.desc'),
    impact: t('users.modals.roles.impact'),
    submitLabel: t('users.modals.roles.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.roles.title'),
    extra: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13 }}>{t('users.modals.roles.selectLabel')}</span>
        {ASSIGNABLE_ROLES.map((role) => (
          <label key={role} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              defaultChecked={selected.has(role)}
              type="checkbox"
              onChange={(e) => {
                if (e.target.checked) selected.add(role);
                else selected.delete(role);
              }}
            />
            <span>{t(`users.roles.${role}`)}</span>
          </label>
        ))}
        <span style={{ fontSize: 12, opacity: 0.75 }}>{t('users.modals.roles.lastSuperNote')}</span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13 }}>{t('users.modals.roles.expiryOptional')}</span>
          <input
            aria-label={t('users.modals.roles.expiryOptional')}
            type="datetime-local"
            onChange={(e) => {
              expiresAtLocal = e.target.value;
            }}
          />
        </label>
      </div>
    ),
    validateExtra: () => {
      if (expiresAtLocal) {
        const d = new Date(expiresAtLocal);
        if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
          return 'users.modals.roles.expiryFuture';
        }
      }
      return null;
    },
    onSubmit: async (reason) => {
      const roleNames = [...selected] as AssignableRoleName[];
      const payload: Omit<AdminUsersReplaceGlobalRolesInput, 'userId'> = {
        reason,
        roleNames,
      };
      if (expiresAtLocal) {
        payload.expiresAt = new Date(expiresAtLocal);
      }
      await params.onConfirm(payload);
      toast.success(t('users.toast.rolesSuccess'));
    },
  });
};
