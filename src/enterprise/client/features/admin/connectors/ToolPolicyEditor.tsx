'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminConnectorToolDraft } from './types';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  row: css`
    display: grid;
    grid-template-columns: minmax(220px, 1fr) 110px 140px 100px 150px;
    gap: 12px;
    align-items: center;

    padding-block: 12px;
    padding-inline: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    &:first-child {
      border-block-start: 0;
    }

    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
}));

interface ToolPolicyEditorProps {
  disabled?: boolean;
  onChange: (
    toolId: string,
    patch: Partial<
      Pick<
        AdminConnectorToolDraft,
        'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel'
      >
    >,
  ) => void;
  tools: AdminConnectorToolDraft[];
}

const ToolPolicyEditor = memo<ToolPolicyEditorProps>(({ disabled, onChange, tools }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={8}>
      <Text strong>{t('connectorCatalog.tools.title')}</Text>
      <Text type={'secondary'}>{t('connectorCatalog.tools.description')}</Text>
      <div className={styles.root}>
        {tools.map((tool) => (
          <div className={styles.row} key={tool.id}>
            <Flexbox gap={2} style={{ minWidth: 0 }}>
              <Text ellipsis strong>
                {tool.displayName}
              </Text>
              <Text code ellipsis type={'secondary'}>
                {tool.toolKey}
              </Text>
            </Flexbox>
            <Flexbox horizontal align={'center'} gap={8}>
              <Switch
                checked={tool.enabled}
                disabled={disabled}
                onChange={(enabled) => onChange(tool.id, { enabled })}
              />
              <Text>{t('connectorCatalog.tools.enabled')}</Text>
            </Flexbox>
            <Select
              disabled={disabled}
              value={tool.platformPolicy}
              options={(['allow', 'deny'] as const).map((value) => ({
                label: t(`connectorCatalog.tools.policy.${value}` as never),
                value,
              }))}
              onChange={(platformPolicy) =>
                onChange(tool.id, {
                  platformPolicy: platformPolicy as AdminConnectorToolDraft['platformPolicy'],
                })
              }
            />
            <Tag
              color={
                tool.riskLevel === 'critical' || tool.riskLevel === 'high' ? 'warning' : 'default'
              }
            >
              {t(`connectorCatalog.risk.${tool.riskLevel}` as never)}
            </Tag>
            <Flexbox horizontal align={'center'} gap={8}>
              <Switch
                checked={tool.requiresConfirmation}
                disabled={disabled}
                onChange={(requiresConfirmation) => onChange(tool.id, { requiresConfirmation })}
              />
              <Text>{t('connectorCatalog.tools.confirmation')}</Text>
            </Flexbox>
          </div>
        ))}
      </div>
    </Flexbox>
  );
});

ToolPolicyEditor.displayName = 'AdminConnectorToolPolicyEditor';

export default ToolPolicyEditor;
