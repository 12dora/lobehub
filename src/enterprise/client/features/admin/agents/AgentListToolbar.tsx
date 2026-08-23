'use client';

import { Flexbox, Input } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import AgentListBulkActions from './AgentListBulkActions';
import type { AdminAgentListItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  toolbar: css`
    width: 100%;
  `,
  toolbarRight: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-inline-start: auto;
  `,
  toolbarSearch: css`
    flex: 0 1 260px;
    min-width: 180px;
    max-width: 320px;
  `,
}));

export interface AgentListToolbarProps {
  authMethod: AdminReauthAuthMethod | null;
  canDelete: boolean;
  /** A query or a status filter is active, so there is something to clear. */
  filtered: boolean;
  onBulkDone: () => Promise<void> | void;
  onClearFilters: () => void;
  /** Commit the typed query to the URL — the search is submitted, never live-filtered. */
  onSubmitQuery: () => void;
  queryDraft: string;
  selectedRows: AdminAgentListItem[];
  setQueryDraft: (next: string) => void;
}

export const AgentListToolbar = memo<AgentListToolbarProps>(
  ({
    authMethod,
    canDelete,
    filtered,
    onBulkDone,
    onClearFilters,
    onSubmitQuery,
    queryDraft,
    selectedRows,
    setQueryDraft,
  }) => {
    const { t } = useTranslation('admin');
    return (
      <Flexbox
        horizontal
        className={styles.toolbar}
        data-testid="agent-list-toolbar"
        justify="space-between"
      >
        <div className={styles.toolbarSearch}>
          <Input
            allowClear
            aria-label={t('agentCatalog.list.search')}
            placeholder={t('agentCatalog.list.search')}
            style={{ width: '100%' }}
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            onPressEnter={onSubmitQuery}
          />
        </div>
        <div className={styles.toolbarRight}>
          {filtered ? (
            <Button size="small" type="text" onClick={onClearFilters}>
              {t('primitives.filterBar.clear')}
            </Button>
          ) : null}
          <AgentListBulkActions
            authMethod={authMethod}
            canDelete={canDelete}
            selectedRows={selectedRows}
            onDone={onBulkDone}
          />
        </div>
      </Flexbox>
    );
  },
);

AgentListToolbar.displayName = 'AgentListToolbar';
