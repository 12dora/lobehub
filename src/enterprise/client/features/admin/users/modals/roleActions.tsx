'use client';

import { DatePicker, Text } from '@lobehub/ui';
import { Checkbox, toast } from '@lobehub/ui/base-ui';
import dayjs, { type Dayjs } from 'dayjs';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_SYSTEM_ROLES, type PlatformSystemRoleName } from '@/const/platform/roles';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminUsersReplaceGlobalRolesInput } from '@/enterprise/client/services/adminUsers';

import { AUTO_REASON } from '../../audit/shared/auditReasonCodes';
import { actionExtraStyles as styles } from './actionExtraStyles';
import { t } from './actionI18n';
import { openReasonModal } from './openReasonModal';

const ALL_ASSIGNABLE: PlatformSystemRoleName[] = [
  PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
  PLATFORM_SYSTEM_ROLES.USER_ADMIN,
  PLATFORM_SYSTEM_ROLES.AI_ADMIN,
  PLATFORM_SYSTEM_ROLES.IDENTITY_ADMIN,
  PLATFORM_SYSTEM_ROLES.AUDITOR,
  PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
];

export const getEligibleAssignableRoles = (
  actorRoles: readonly { name: string }[],
): PlatformSystemRoleName[] => {
  const isSuper = actorRoles.some((r) => r.name === PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
  if (isSuper) return [...ALL_ASSIGNABLE];
  return ALL_ASSIGNABLE.filter((r) => r !== PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
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
            disabledDate={(d) => d.isBefore(dayjs(), 'day')}
            placeholder={tr('primitives.datePicker.placeholder')}
            value={expiresAt}
            onChange={(v) => onExpiresAtChange(v as Dayjs | null)}
          />
        </>
      )}
    </div>
  );
});
RolesExtra.displayName = 'RolesExtra';

/** Current global grant snapshot for replace-roles (name + optional per-grant expiry). */
export type AdminUserRoleGrant = {
  expiresAt?: Date | null;
  name: string;
};

/**
 * Per-role reconcile for replaceGlobalRoles.
 *
 * Never blanket-replaces the whole grant set: protected (inaccessible) roles always
 * remain, and unchanged remaining grants are listed in `preserveRoleNames` so the
 * server leaves their `expiresAt` untouched instead of delete+reinsert.
 *
 * When a shared expiry is applied, only protected roles stay in `preserveRoleNames`
 * (untouched); selected eligible roles are rewritten with the shared expiry.
 */
export const buildReplaceGlobalRolesPayload = (params: {
  /** Role names the actor is allowed to assign/remove. */
  eligibleRoleNames: readonly PlatformSystemRoleName[];
  /** Full current grants on the target (name + optional expiry metadata). */
  currentRoles: readonly AdminUserRoleGrant[] | readonly string[];
  reason: string;
  /** Eligible roles the actor currently has selected in the modal. */
  selectedRoleNames: readonly string[];
  /** Optional shared expiry applied to rewritten (non-preserved) grants. */
  sharedExpiresAt?: Date | null;
  userId: string;
}): AdminUsersReplaceGlobalRolesInput => {
  const eligibleSet = new Set<string>(params.eligibleRoleNames);
  const currentGrants: AdminUserRoleGrant[] = params.currentRoles.map((entry) =>
    typeof entry === 'string' ? { name: entry } : entry,
  );
  const currentNames = currentGrants.map((g) => g.name);

  // Roles the actor cannot assign must stay on the target (e.g. super_admin when actor is user_admin).
  const protectedRoleNames = currentNames.filter(
    (name) => !eligibleSet.has(name),
  ) as PlatformSystemRoleName[];

  const selectedEligible = params.selectedRoleNames.filter((r) =>
    eligibleSet.has(r),
  ) as PlatformSystemRoleName[];

  // Always retain inaccessible current grants so the server does not treat the
  // request as a demotion the actor was never authorized to perform.
  const roleNames = [
    ...new Set([...selectedEligible, ...protectedRoleNames]),
  ] as PlatformSystemRoleName[];

  const sharedExpiresAt =
    params.sharedExpiresAt && !roleNames.includes(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN)
      ? params.sharedExpiresAt
      : undefined;

  // When no shared expiry is applied: preserve every remaining grant so
  // delete+reinsert does not clear per-grant expiresAt (e.g. temporary auditor).
  // When a shared expiry IS set: only re-write eligible selected roles; still
  // preserve protected roles (server skips super_admin expiry updates).
  const preserveRoleNames = sharedExpiresAt
    ? protectedRoleNames
    : ([
        ...new Set([
          ...protectedRoleNames,
          ...selectedEligible.filter((name) => currentNames.includes(name)),
        ]),
      ] as PlatformSystemRoleName[]);

  const payload: AdminUsersReplaceGlobalRolesInput = {
    preserveRoleNames,
    reason: params.reason,
    roleNames,
    userId: params.userId,
  };
  if (sharedExpiresAt) {
    payload.expiresAt = sharedExpiresAt;
  }
  return payload;
};

export const openReplaceRolesModal = (params: {
  actorRoles: readonly { name: string }[];
  authMethod?: AdminReauthAuthMethod;
  /** Full current grants — inaccessible roles are preserved, not dropped. */
  currentRoles: readonly AdminUserRoleGrant[] | readonly string[];
  onConfirm: (input: AdminUsersReplaceGlobalRolesInput) => Promise<unknown>;
  targetLabel: string;
  userId: string;
}) => {
  const eligible = getEligibleAssignableRoles(params.actorRoles);
  const eligibleSet = new Set<string>(eligible);

  // Normalize grant objects (callers may still pass bare names for tests).
  const currentGrants: AdminUserRoleGrant[] = params.currentRoles.map((entry) =>
    typeof entry === 'string' ? { name: entry } : entry,
  );
  const currentNames = currentGrants.map((g) => g.name);
  const initial = new Set(currentNames.filter((r) => eligibleSet.has(r)));

  // Updated only from onChange handlers — never during render.
  const rolesState = {
    expiresAt: null as Dayjs | null,
    selected: new Set(initial),
  };

  const ControlledRoles = memo<{ locked: boolean; reportExtraChange: () => void }>(
    ({ locked, reportExtraChange }) => {
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
            reportExtraChange();
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
            reportExtraChange();
          }}
        />
      );
    },
  );
  ControlledRoles.displayName = 'ControlledRoles';

  openReasonModal({
    authMethod: params.authMethod,
    autoReason: AUTO_REASON.roles,
    hideReason: true,
    submitLabel: t('users.modals.roles.confirm'),
    targetLabel: params.targetLabel,
    title: t('users.modals.roles.title'),
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
      if (rolesState.selected.has(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN) && rolesState.expiresAt) {
        return 'users.modals.roles.superAdminNoExpiry';
      }
      if (rolesState.expiresAt && !rolesState.expiresAt.isAfter(dayjs())) {
        return 'users.modals.roles.expiryFuture';
      }
      return null;
    },
    buildPayload: (reason) =>
      buildReplaceGlobalRolesPayload({
        currentRoles: currentGrants,
        eligibleRoleNames: eligible,
        reason,
        selectedRoleNames: [...rolesState.selected],
        sharedExpiresAt: rolesState.expiresAt ? rolesState.expiresAt.toDate() : null,
        userId: params.userId,
      }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersReplaceGlobalRolesInput);
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
  onConfirm: (input: AdminUsersReplaceGlobalRolesInput) => Promise<unknown>;
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
      userId: params.userId,
    }),
    onSubmit: async (payload) => {
      await params.onConfirm(payload as AdminUsersReplaceGlobalRolesInput);
      toast.success(t('users.toast.roleRevokeSuccess'));
    },
  });
};
