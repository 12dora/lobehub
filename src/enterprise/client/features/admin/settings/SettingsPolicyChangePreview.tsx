'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { formatPolicySummary } from './policyPresentation';
import type { PolicyDiffRow } from './settingsPolicyController';

const styles = createStaticStyles(({ css }) => ({
  previewRow: css`
    display: grid;
    grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) minmax(220px, 1fr);
    gap: 8px;

    padding-block: 6px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 760px) {
      grid-template-columns: 1fr;
    }
  `,
}));

export interface SettingsPolicyChangePreviewProps {
  preview: PolicyDiffRow[];
  registryByPath: Map<string, AdminSettingsGetDraftOutput['registry'][number]>;
}

const SettingsPolicyChangePreview = memo<SettingsPolicyChangePreviewProps>(
  ({ preview, registryByPath }) => {
    const { t } = useTranslation('admin');

    if (preview.length === 0) return null;

    return (
      <div>
        <Text strong>{t('settingsPolicy.changePreview')}</Text>
        {preview.map((row) => {
          const entry = registryByPath.get(row.path);
          return (
            <div className={styles.previewRow} key={row.path}>
              <Text strong>
                {entry ? t(entry.titleKey as never, { defaultValue: row.path }) : row.path}
              </Text>
              {entry ? (
                <>
                  <Text type="secondary">
                    {t('settingsPolicy.preview.before', {
                      summary: formatPolicySummary({
                        entry,
                        mode: row.beforeMode,
                        t,
                        value: row.beforeValue,
                        visibility: row.beforeVisibility,
                      }),
                    })}
                  </Text>
                  <Text type="secondary">
                    {t('settingsPolicy.preview.after', {
                      summary: formatPolicySummary({
                        entry,
                        mode: row.afterMode,
                        t,
                        value: row.afterValue,
                        visibility: row.afterVisibility,
                      }),
                    })}
                  </Text>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  },
);

SettingsPolicyChangePreview.displayName = 'SettingsPolicyChangePreview';

export default SettingsPolicyChangePreview;
