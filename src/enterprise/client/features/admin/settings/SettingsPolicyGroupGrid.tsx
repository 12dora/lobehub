'use client';

import { Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { formatSettingValue } from './policyPresentation';
import { PolicyValueEditor } from './PolicyValueEditor';
import type { DraftPolicy, SettingsPolicyUiMode } from './settingsPolicyController';
import {
  fromSettingsPolicyUiMode,
  SETTINGS_POLICY_GROUPS,
  toSettingsPolicyUiMode,
} from './settingsPolicyController';

const styles = createStaticStyles(({ css }) => ({
  empty: css`
    padding: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  fieldHeader: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
  `,
  titleBlock: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    /* Allow the title to ellipsize instead of pushing the mode select off-row. */
    min-width: 0;
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  grid: css`
    display: grid;

    /* Equal-height rows so every setting box lines up as a uniform tile. */
    grid-auto-rows: 1fr;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  `,
  path: css`
    overflow: hidden;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  row: css`
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
}));

const UI_MODE_VALUES = ['user', 'platform'] as const satisfies readonly SettingsPolicyUiMode[];

export interface SettingsPolicyGroupGridProps {
  canUpdate: boolean;
  entries: AdminSettingsGetDraftOutput['registry'];
  getPolicy: (path: string) => DraftPolicy;
  publishedPolicies: AdminSettingsGetDraftOutput['publishedPolicies'];
  updatePolicy: (path: string, patch: Partial<DraftPolicy>) => void;
}

const SettingsPolicyGroupGrid = memo<SettingsPolicyGroupGridProps>(
  ({ canUpdate, entries, getPolicy, publishedPolicies, updatePolicy }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        {SETTINGS_POLICY_GROUPS.map((group) => {
          const groupEntries = entries.filter((e) => e.group === group);
          if (groupEntries.length === 0) return null;
          return (
            <div className={styles.group} key={group}>
              <Text strong>{t(`settingsPolicy.groups.${group}` as never)}</Text>
              <div className={styles.grid}>
                {groupEntries.map((entry) => {
                  const policy = getPolicy(entry.path);
                  return (
                    <div className={styles.field} id={`setting-${entry.path}`} key={entry.path}>
                      <div className={styles.fieldHeader}>
                        <div className={styles.titleBlock}>
                          <Text strong ellipsis={{ tooltip: true, tooltipWhenOverflow: true }}>
                            {t(entry.titleKey as never, { defaultValue: entry.path })}
                          </Text>
                          <div className={styles.path} title={entry.path}>
                            {entry.path}
                          </div>
                        </div>
                        <div className={styles.row}>
                          <Select
                            aria-label={t('settingsPolicy.uiMode.label')}
                            disabled={!canUpdate}
                            // Unified policy-mode select width — keep in sync with the managed-resource boxes.
                            style={{ width: 180 }}
                            value={toSettingsPolicyUiMode(policy)}
                            options={UI_MODE_VALUES.map((value) => ({
                              label: t(`settingsPolicy.uiMode.${value}` as never),
                              value,
                            }))}
                            onChange={(v) =>
                              updatePolicy(entry.path, {
                                ...fromSettingsPolicyUiMode(v as SettingsPolicyUiMode),
                              })
                            }
                          />
                        </div>
                      </div>
                      <Text type="secondary">
                        {t(entry.descriptionKey as never, { defaultValue: '' })}
                      </Text>
                      <PolicyValueEditor
                        control={entry.control}
                        disabled={!canUpdate}
                        label={t(entry.titleKey as never, { defaultValue: entry.path })}
                        max={entry.max}
                        min={entry.min}
                        options={entry.options}
                        step={entry.step}
                        value={policy.value}
                        onChange={(value) => updatePolicy(entry.path, { value })}
                      />
                      {publishedPolicies[entry.path] ? (
                        <Text type="secondary">
                          {t('settingsPolicy.publishedValue')}:{' '}
                          {formatSettingValue({
                            entry,
                            t,
                            value: publishedPolicies[entry.path]?.value,
                          })}
                        </Text>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {entries.length === 0 ? (
          <div className={styles.empty}>{t('settingsPolicy.noResults')}</div>
        ) : null}
      </>
    );
  },
);

SettingsPolicyGroupGrid.displayName = 'SettingsPolicyGroupGrid';

export default SettingsPolicyGroupGrid;
