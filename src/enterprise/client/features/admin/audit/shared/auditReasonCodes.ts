/**
 * Stable machine reason codes persisted in the platform audit trail (`platform_audit_logs.reason`)
 * and in `user.banReason`. Confirm-only admin actions no longer ask the operator to type a reason,
 * so the client writes a code and the UI localizes it at render time via `audit.autoReason.*`.
 *
 * Do not change a code once shipped — historical rows keep the value they were written with.
 * Prose written by older clients stays readable through `AUTO_REASON_LEGACY`.
 *
 * Kept dependency-free so audit tables, user tabs and the action hooks can all import it without
 * pulling in modal UI trees.
 */

/** User admin confirm-only actions. */
export const AUTO_REASON = {
  delete: 'admin.users.delete',
  revokeAll: 'admin.users.revoke_all_sessions',
  revokeOne: 'admin.users.revoke_session',
  roleRevoke: 'admin.users.revoke_role',
  roles: 'admin.users.replace_roles',
} as const;

export const CREATE_USER_AUTO_REASON = 'admin.users.create';

/** Managed-resources shared OAuth authorization toggle. */
export const SHARED_OAUTH_AUTO_REASON = 'admin.connectors.shared_oauth';

/** Connector catalog rollback. */
export const CONNECTOR_ROLLBACK_AUTO_REASON = 'admin.connectors.rollback';

/** Platform assistant archive. */
export const AGENT_ARCHIVE_AUTO_REASON = 'admin.agents.archive';

/** One-click org actions taken from the parity tool-scope settings UI. */
export const TOOL_SCOPE_AUTO_REASON = {
  builtinToolPolicy: 'admin.tool_scope.builtin_tool_policy',
  connectorCreate: 'admin.tool_scope.connector_create',
  connectorDelete: 'admin.tool_scope.connector_delete',
  connectorDiscover: 'admin.tool_scope.connector_discover',
  connectorPolicy: 'admin.tool_scope.connector_policy',
  skillDelete: 'admin.tool_scope.skill_delete',
  skillDistribution: 'admin.tool_scope.skill_distribution',
  skillImport: 'admin.tool_scope.skill_import',
} as const;

/**
 * Server-written auto-ban code (content moderation). Persisted with the violation count appended
 * as `content_moderation.auto_ban:<n>` — see `contentModeration/constants.ts` on the server.
 */
export const MODERATION_AUTO_BAN_REASON_CODE = 'content_moderation.auto_ban';

/** Legacy prose reasons (pre-code) still present in historical audit rows / ban reasons. */
export const AUTO_REASON_LEGACY = {
  agentArchive: 'Platform assistant archived from admin console',
  connectorRollback: 'Connector rolled back from admin console',
  create: 'User created from admin console',
  delete: 'User hard-deleted from admin console',
  revokeAll: 'All sessions revoked from admin console',
  revokeOne: 'Session revoked from admin console',
  roleRevoke: 'Global role revoked from admin console',
  roles: 'Global roles updated from admin console',
  sharedOAuth: 'Set org shared OAuth authorization from managed resources',
  toolScopeBuiltinToolPolicy: 'Update org builtin tool policy from admin settings',
  toolScopeConnectorCreate: 'Create platform connector from admin settings',
  toolScopeConnectorDelete: 'Remove platform connector from admin settings',
  toolScopeConnectorDiscover: 'Discover connector tools from admin settings',
  toolScopeConnectorPolicy: 'Update connector tool policy from admin settings',
  toolScopeSkillDelete: 'Remove organization skill from admin settings',
  toolScopeSkillDistribution: 'Set organization skill default from admin settings',
  toolScopeSkillImport: 'Import organization skill from admin settings',
} as const;

/**
 * Stable reason codes (+ legacy prose from older clients) → i18n key under `audit.autoReason.*`.
 *
 * A Map, not an object: reasons arrive from the database, and an object lookup would resolve
 * inherited members such as `constructor` to a non-key value.
 */
const AUTO_REASON_I18N_KEY = new Map<string, string>(
  Object.entries({
    [AGENT_ARCHIVE_AUTO_REASON]: 'audit.autoReason.agentArchive',
    [AUTO_REASON.delete]: 'audit.autoReason.delete',
    [AUTO_REASON.revokeAll]: 'audit.autoReason.revokeAll',
    [AUTO_REASON.revokeOne]: 'audit.autoReason.revokeOne',
    [AUTO_REASON.roleRevoke]: 'audit.autoReason.roleRevoke',
    [AUTO_REASON.roles]: 'audit.autoReason.roles',
    [CONNECTOR_ROLLBACK_AUTO_REASON]: 'audit.autoReason.connectorRollback',
    [CREATE_USER_AUTO_REASON]: 'audit.autoReason.create',
    [SHARED_OAUTH_AUTO_REASON]: 'audit.autoReason.sharedOAuth',
    [TOOL_SCOPE_AUTO_REASON.builtinToolPolicy]: 'audit.autoReason.toolScope.builtinToolPolicy',
    [TOOL_SCOPE_AUTO_REASON.connectorCreate]: 'audit.autoReason.toolScope.connectorCreate',
    [TOOL_SCOPE_AUTO_REASON.connectorDelete]: 'audit.autoReason.toolScope.connectorDelete',
    [TOOL_SCOPE_AUTO_REASON.connectorDiscover]: 'audit.autoReason.toolScope.connectorDiscover',
    [TOOL_SCOPE_AUTO_REASON.connectorPolicy]: 'audit.autoReason.toolScope.connectorPolicy',
    [TOOL_SCOPE_AUTO_REASON.skillDelete]: 'audit.autoReason.toolScope.skillDelete',
    [TOOL_SCOPE_AUTO_REASON.skillDistribution]: 'audit.autoReason.toolScope.skillDistribution',
    [TOOL_SCOPE_AUTO_REASON.skillImport]: 'audit.autoReason.toolScope.skillImport',
    // Historical prose written by pre-code clients.
    [AUTO_REASON_LEGACY.agentArchive]: 'audit.autoReason.agentArchive',
    [AUTO_REASON_LEGACY.connectorRollback]: 'audit.autoReason.connectorRollback',
    [AUTO_REASON_LEGACY.create]: 'audit.autoReason.create',
    [AUTO_REASON_LEGACY.delete]: 'audit.autoReason.delete',
    [AUTO_REASON_LEGACY.revokeAll]: 'audit.autoReason.revokeAll',
    [AUTO_REASON_LEGACY.revokeOne]: 'audit.autoReason.revokeOne',
    [AUTO_REASON_LEGACY.roleRevoke]: 'audit.autoReason.roleRevoke',
    [AUTO_REASON_LEGACY.roles]: 'audit.autoReason.roles',
    [AUTO_REASON_LEGACY.sharedOAuth]: 'audit.autoReason.sharedOAuth',
    [AUTO_REASON_LEGACY.toolScopeBuiltinToolPolicy]: 'audit.autoReason.toolScope.builtinToolPolicy',
    [AUTO_REASON_LEGACY.toolScopeConnectorCreate]: 'audit.autoReason.toolScope.connectorCreate',
    [AUTO_REASON_LEGACY.toolScopeConnectorDelete]: 'audit.autoReason.toolScope.connectorDelete',
    [AUTO_REASON_LEGACY.toolScopeConnectorDiscover]: 'audit.autoReason.toolScope.connectorDiscover',
    [AUTO_REASON_LEGACY.toolScopeConnectorPolicy]: 'audit.autoReason.toolScope.connectorPolicy',
    [AUTO_REASON_LEGACY.toolScopeSkillDelete]: 'audit.autoReason.toolScope.skillDelete',
    [AUTO_REASON_LEGACY.toolScopeSkillDistribution]: 'audit.autoReason.toolScope.skillDistribution',
    [AUTO_REASON_LEGACY.toolScopeSkillImport]: 'audit.autoReason.toolScope.skillImport',
  }),
);

/** `content_moderation.auto_ban:<violations>` written by the moderation recorder. */
const MODERATION_AUTO_BAN_PATTERN = new RegExp(`^${MODERATION_AUTO_BAN_REASON_CODE}:(\\d+)$`);
/** Prose written by moderation builds before the machine code. */
const MODERATION_AUTO_BAN_LEGACY_PATTERN = /^内容审计：窗口内违规\s*(\d+)\s*次$/;

interface CountedReason {
  count: number;
  key: string;
}

/**
 * Reasons that carry a numeric parameter after the stable code.
 *
 * The count is a violation tally, so only a positive, exactly representable integer can be
 * interpolated: `:0` is not a real auto-ban, and a value past `Number.MAX_SAFE_INTEGER` would be
 * rounded by `parseInt` and rendered as a number the recorder never wrote. Anything else falls
 * through so the caller shows the stored reason verbatim instead of inventing a figure.
 */
const parseCountedReason = (reason: string): CountedReason | null => {
  const match =
    MODERATION_AUTO_BAN_PATTERN.exec(reason) ?? MODERATION_AUTO_BAN_LEGACY_PATTERN.exec(reason);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return { count, key: 'audit.autoReason.moderationAutoBan' };
};

export type AuditReasonTranslate = (
  key: string,
  options?: { count?: number; defaultValue?: string },
) => string;

/**
 * Resolve a persisted audit reason (or ban reason) for display.
 * Free-form reasons typed by an administrator pass through verbatim.
 */
export const formatAuditReason = (
  reason: string | null | undefined,
  t: AuditReasonTranslate,
): string | null => {
  if (!reason) return null;
  const key = AUTO_REASON_I18N_KEY.get(reason);
  if (key) return t(key, { defaultValue: reason });
  const counted = parseCountedReason(reason);
  if (counted) return t(counted.key, { count: counted.count, defaultValue: reason });
  return reason;
};
