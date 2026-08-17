import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { ConnectorToolPermission } from '@/database/schemas';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';

import type { AdminConnectorGetOutput, AdminConnectorListItem } from '../../connectors/types';
import type { AdminSkillListItem } from '../../skills/types';

export const SKILL_PAGE_LIMIT = 100;
export const CONNECTOR_PAGE_LIMIT = 100;
/** Bounded getBatch size — server caps batch detail fetches. */
export const CONNECTOR_DETAIL_BATCH = 50;

/** Traverse every skill list page so large org catalogs are not silently truncated. */
export const listAllAdminSkills = async (): Promise<AdminSkillListItem[]> => {
  const items: AdminSkillListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await adminSkillsService.list({ cursor, limit: SKILL_PAGE_LIMIT });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
};

/** Traverse every connector list page. */
export const listAllAdminConnectors = async (): Promise<AdminConnectorListItem[]> => {
  const items: AdminConnectorListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await adminConnectorsService.list({ cursor, limit: CONNECTOR_PAGE_LIMIT });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
};

/** Load connector details in bounded batches; collect failed IDs across batches. */
export const loadAllConnectorDetails = async (
  ids: string[],
): Promise<{ failedIds: string[]; items: AdminConnectorGetOutput[] }> => {
  const items: AdminConnectorGetOutput[] = [];
  const failedIds: string[] = [];
  for (let offset = 0; offset < ids.length; offset += CONNECTOR_DETAIL_BATCH) {
    const batchIds = ids.slice(offset, offset + CONNECTOR_DETAIL_BATCH);
    const batch = await adminConnectorsService.getBatch({ ids: batchIds });
    items.push(...batch.items);
    failedIds.push(...batch.failedIds);
  }
  return { failedIds, items };
};

/**
 * Immediate create/archive/update all publish in one shot — require both the
 * mutation permission and the matching PUBLISH permission.
 */
export const deriveToolScopeCapabilities = (
  permissions: readonly string[],
): AdminToolScopeCapabilities => {
  const granted = new Set(permissions);
  const skillPublish = granted.has(PLATFORM_PERMISSIONS.SKILL_PUBLISH);
  const connectorPublish = granted.has(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH);
  return {
    canCreateConnector: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_CREATE) && connectorPublish,
    canCreateSkill: granted.has(PLATFORM_PERMISSIONS.SKILL_CREATE) && skillPublish,
    canDeleteConnector: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_DELETE) && connectorPublish,
    canDeleteSkill: granted.has(PLATFORM_PERMISSIONS.SKILL_DELETE) && skillPublish,
    canUpdateConnector: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE) && connectorPublish,
    canUpdateSkill: granted.has(PLATFORM_PERMISSIONS.SKILL_UPDATE) && skillPublish,
  };
};

/**
 * Stable audit reason codes for one-click org actions taken from the parity settings UI.
 * Localized at render time — see `audit/shared/auditReasonCodes`.
 */
export { TOOL_SCOPE_AUTO_REASON as REASONS } from '../../audit/shared/auditReasonCodes';

/** Synthetic row-id prefix for builtin in-process tools shown in the connector view. */
export const BUILTIN_ROW_PREFIX = 'admin-builtin:';
/** Tool-id format for platform connector tools: `platform:<connectorId>:<toolKey>`. */
export const PLATFORM_TOOL_PREFIX = 'platform:';

export const sanitizeSkillKey = (raw: string): string =>
  raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[^a-z0-9]+|[-._]+$/g, '')
    .slice(0, 120);

export const policyToPermission = (tool: {
  platformPolicy: 'allow' | 'deny';
  requiresConfirmation: boolean;
}): ConnectorToolPermission => {
  if (tool.platformPolicy === 'deny') return ConnectorToolPermission.disabled;
  return tool.requiresConfirmation
    ? ConnectorToolPermission.needs_approval
    : ConnectorToolPermission.auto;
};

export const permissionToPolicy = (
  permission: ConnectorToolPermission,
): { platformPolicy: 'allow' | 'deny'; requiresConfirmation: boolean } => {
  if (permission === ConnectorToolPermission.disabled)
    return { platformPolicy: 'deny', requiresConfirmation: false };
  return {
    platformPolicy: 'allow',
    requiresConfirmation: permission === ConnectorToolPermission.needs_approval,
  };
};
