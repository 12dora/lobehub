'use client';

import { Tag } from '@lobehub/ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type { TFunction } from 'i18next';

import { enumColumnFilter } from '../primitives/columnFilters';
import StatusBadge from '../primitives/StatusBadge';
import { AgentListRowActions, type AgentListRowActionsProps } from './AgentListRowActions';
import type { AdminAgentListItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  /**
   * Name and identifier on ONE line: the identifier is secondary context for the name, and a
   * two-line cell is what made every row 70px tall.
   */
  identity: css`
    display: flex;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
  `,
  identityKey: css`
    overflow: hidden;
    flex: 0 1 auto;

    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  identityName: css`
    overflow: hidden;
    flex: 0 1 auto;

    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

export interface BuildAgentListColumnsParams extends Omit<AgentListRowActionsProps, 'item'> {
  hasRowActions: boolean;
  status: AdminAgentListItem['identity']['status'] | undefined;
  t: TFunction<'admin'>;
}

export const buildAgentListColumns = ({
  agentPermissions,
  availability,
  canOpenEditor,
  hasRowActions,
  openDelete,
  openEditor,
  rowActions,
  status,
  t,
}: BuildAgentListColumnsParams): TableColumnsType<AdminAgentListItem> => [
  {
    ellipsis: true,
    key: 'agent',
    title: t('agentCatalog.list.columns.agent'),
    width: 340,
    render: (_, item) => (
      <div className={styles.identity}>
        <span className={styles.identityName}>{item.displayName}</span>
        <span className={styles.identityKey}>{item.identity.agentKey}</span>
      </div>
    ),
  },
  {
    key: 'status',
    title: t('agentCatalog.list.columns.status'),
    width: 140,
    render: (_, item) => <StatusBadge status={item.identity.status} />,
    ...enumColumnFilter({
      options: (['published', 'archived'] as const).map((value) => ({
        label: t(`agentCatalog.status.${value}` as never),
        value,
      })),
      value: status,
    }),
  },
  {
    dataIndex: 'assignmentCount',
    key: 'assignmentCount',
    title: t('agentCatalog.list.columns.assignments'),
    width: 100,
  },
  {
    key: 'isDefault',
    title: t('agentCatalog.list.columns.scope'),
    width: 120,
    render: (_, item) => (
      <Tag size="small">
        {item.identity.isDefault ? t('agentCatalog.defaultInbox') : t('agentCatalog.standard')}
      </Tag>
    ),
  },
  ...(hasRowActions
    ? [
        {
          key: 'actions',
          title: t('agentCatalog.list.columns.actions'),
          width: 200,
          render: (_: unknown, item: AdminAgentListItem) => (
            <AgentListRowActions
              agentPermissions={agentPermissions}
              availability={availability}
              canOpenEditor={canOpenEditor}
              item={item}
              openDelete={openDelete}
              openEditor={openEditor}
              rowActions={rowActions}
            />
          ),
        },
      ]
    : []),
];
