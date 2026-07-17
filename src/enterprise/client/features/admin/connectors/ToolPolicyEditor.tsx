'use client';

import { Flexbox, InputNumber, Text } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
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
    grid-template-columns: minmax(220px, 1fr) 110px 140px 140px 100px 150px;
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
        'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel' | 'sort'
      >
    >,
  ) => void;
  tools: AdminConnectorToolDraft[];
}

const ToolPolicyEditor = memo<ToolPolicyEditorProps>(({ disabled, onChange, tools }) => {
  const { t } = useTranslation('admin');
  const sortedTools = useMemo(
    () =>
      [...tools].sort(
        (left, right) =>
          left.sort - right.sort ||
          left.toolKey.localeCompare(right.toolKey) ||
          left.id.localeCompare(right.id),
      ),
    [tools],
  );

  return (
    <Flexbox gap={8}>
      <Text strong>{t('connectorCatalog.tools.title')}</Text>
      <Text type={'secondary'}>{t('connectorCatalog.tools.description')}</Text>
      <div className={styles.root}>
        {sortedTools.map((tool) => {
          const confirmationRequired = tool.riskLevel === 'critical' || tool.riskLevel === 'high';
          return (
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
              <Select
                aria-label={t('connectorCatalog.tools.riskLevel')}
                disabled={disabled}
                value={tool.riskLevel}
                options={(['low', 'medium', 'high', 'critical'] as const).map((value) => ({
                  label: t(`connectorCatalog.risk.${value}` as never),
                  value,
                }))}
                onChange={(riskLevel) =>
                  onChange(tool.id, {
                    requiresConfirmation:
                      riskLevel === 'critical' || riskLevel === 'high'
                        ? true
                        : tool.requiresConfirmation,
                    riskLevel: riskLevel as AdminConnectorToolDraft['riskLevel'],
                  })
                }
              />
              <InputNumber
                aria-label={t('connectorCatalog.tools.sort')}
                disabled={disabled}
                precision={0}
                value={tool.sort}
                onChange={(sort) => {
                  if (typeof sort === 'number' && Number.isInteger(sort)) {
                    onChange(tool.id, { sort });
                  }
                }}
              />
              <Flexbox horizontal align={'center'} gap={8}>
                <Switch
                  checked={confirmationRequired || tool.requiresConfirmation}
                  disabled={disabled || confirmationRequired}
                  onChange={(requiresConfirmation) => onChange(tool.id, { requiresConfirmation })}
                />
                <Text>{t('connectorCatalog.tools.confirmation')}</Text>
              </Flexbox>
            </div>
          );
        })}
      </div>
    </Flexbox>
  );
});

ToolPolicyEditor.displayName = 'AdminConnectorToolPolicyEditor';

export default ToolPolicyEditor;
