'use client';

import { Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  toolbarLeft: css`
    flex: 1 1 240px;
    min-width: 200px;
    max-width: 320px;
  `,
  toolbarRight: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-inline-start: auto;
  `,
}));

export interface AgentTemplateListToolbarProps {
  canDelete: boolean;
  onBulkDelete: () => void;
  onQueryChange: (value: string) => void;
  query: string;
  selectedCount: number;
}

/**
 * Table toolbar: search on the left, bulk actions on the right once rows are selected.
 * Mirrors the users list so both admin tables behave the same way.
 */
const AgentTemplateListToolbar = memo<AgentTemplateListToolbarProps>(
  ({ canDelete, onBulkDelete, onQueryChange, query, selectedCount }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <Input
            allowClear
            aria-label={t('agentTemplateCatalog.list.filters.query')}
            placeholder={t('agentTemplateCatalog.list.filters.query')}
            style={{ width: '100%' }}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        {selectedCount > 0 ? (
          <div className={styles.toolbarRight}>
            <Text type="secondary">
              {t('agentTemplateCatalog.list.selectedCount', { count: selectedCount })}
            </Text>
            {canDelete ? (
              <Button danger size="small" onClick={onBulkDelete}>
                {t('agentTemplateCatalog.list.bulk.delete')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  },
);

AgentTemplateListToolbar.displayName = 'AdminAgentTemplateListToolbar';

export default AgentTemplateListToolbar;
