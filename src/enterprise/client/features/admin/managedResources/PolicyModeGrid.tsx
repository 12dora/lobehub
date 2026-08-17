'use client';

import { Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import {
  MANAGED_RESOURCE_NAV_LABEL_KEY,
  type ManagedResourceUiMode,
  toManagedResourceUiMode,
} from './controller';
import { managedResourcePolicyCardStyles, POLICY_MODE_SELECT_WIDTH } from './policyCardStyles';
import { policyPageStyles } from './policyPageStyles';
import SharedOAuthAuthorizationControl from './SharedOAuthAuthorizationControl';
import SidebarLayoutControl from './SidebarLayoutControl';

const UI_MODE_VALUES = ['user', 'platform'] as const satisfies readonly ManagedResourceUiMode[];

export interface PolicyModeGridProps {
  canEditPolicy: boolean;
  canReadConnectorGovernance: boolean;
  canUpdateConnectorGovernance: boolean;
  canUpdateSidebarLayout: boolean;
  draft: ManagedResourcePolicyMap;
  editorsLocked: boolean;
  onModeChange: (resource: ManagedResourceKind, mode: ManagedResourceUiMode) => void;
}

const PolicyModeGrid = memo<PolicyModeGridProps>(
  ({
    canEditPolicy,
    canReadConnectorGovernance,
    canUpdateConnectorGovernance,
    canUpdateSidebarLayout,
    draft,
    editorsLocked,
    onModeChange,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={policyPageStyles.grid}>
        {MANAGED_RESOURCE_KINDS.map((resource) => {
          const item = draft[resource];
          const uiMode = toManagedResourceUiMode(item);
          return (
            <section className={managedResourcePolicyCardStyles.card} key={resource}>
              <div className={managedResourcePolicyCardStyles.row}>
                <Text
                  strong
                  ellipsis={{ tooltip: true, tooltipWhenOverflow: true }}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)}
                </Text>
                <Select
                  aria-label={`${t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)} ${t('managedResources.uiMode.label')}`}
                  disabled={!canEditPolicy}
                  style={{ flexShrink: 0, width: POLICY_MODE_SELECT_WIDTH }}
                  value={uiMode}
                  options={UI_MODE_VALUES.map((mode) => ({
                    label: t(`managedResources.uiMode.${mode}` as never),
                    value: mode,
                  }))}
                  onChange={(mode) => onModeChange(resource, mode as ManagedResourceUiMode)}
                />
              </div>
              {resource === 'connectors' ? (
                <SharedOAuthAuthorizationControl
                  canRead={canReadConnectorGovernance}
                  canUpdate={canUpdateConnectorGovernance}
                  disabled={editorsLocked}
                />
              ) : null}
            </section>
          );
        })}

        <SidebarLayoutControl canUpdate={canUpdateSidebarLayout} disabled={editorsLocked} />
      </div>
    );
  },
);

PolicyModeGrid.displayName = 'PolicyModeGrid';

export default PolicyModeGrid;
