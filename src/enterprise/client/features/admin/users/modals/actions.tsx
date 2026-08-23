'use client';

/**
 * Barrel for the per-user action modals.
 *
 * The individual openers live next to each other in one module per action family
 * (ban, sessions, roles, delete); this path stays the single import surface every
 * caller — and every test mock — already targets.
 */

export { openBanUserModal, openUnbanUserModal } from './banActions';
export { openDeleteUserModal } from './deleteActions';
export { BanExtraFields, type BanMode } from './extras';
export {
  type AdminUserRoleGrant,
  buildReplaceGlobalRolesPayload,
  getEligibleAssignableRoles,
  openReplaceRolesModal,
  openRevokeRoleModal,
} from './roleActions';
export { openRevokeSessionsModal, openRevokeSingleSessionModal } from './sessionActions';
