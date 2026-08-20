'use client';

import { Avatar, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { Table } from 'antd';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';

import { enumColumnFilter } from '../primitives/columnFilters';
import { formatAdminDateTime } from '../users/utils';
import { AgentTemplateDragHandle } from './SortableRow';
import type { AdminAgentTemplateItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
  identityText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  rowActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  tags: css`
    overflow: hidden;
    display: flex;
    gap: 4px;
    align-items: center;

    min-width: 0;
  `,
}));

/** Tags rendered inline before the rest collapses into a "+N" tag. */
const TAG_LIMIT = 2;

export interface BuildAgentTemplateColumnsParams {
  canDelete: boolean;
  canUpdate: boolean;
  enabledParam: string | null;
  handleDelete: (item: AdminAgentTemplateItem) => void;
  handleToggle: (item: AdminAgentTemplateItem, next: boolean) => void;
  openEditor: (item?: AdminAgentTemplateItem) => void;
  pendingEnabled: Record<string, boolean>;
  /** Render the bulk-selection checkbox column right after the drag handle. */
  selectable: boolean;
  t: TFunction<'admin'>;
}

export const buildAgentTemplateColumns = ({
  canDelete,
  canUpdate,
  enabledParam,
  handleDelete,
  handleToggle,
  openEditor,
  pendingEnabled,
  selectable,
  t,
}: BuildAgentTemplateColumnsParams): TableColumnsType<AdminAgentTemplateItem> => {
  const columns: TableColumnsType<AdminAgentTemplateItem> = [
    {
      key: 'order',
      title: t('agentTemplateCatalog.list.columns.order'),
      width: 56,
      render: (_, item) => (
        <AgentTemplateDragHandle
          label={t('agentTemplateCatalog.list.dragHandle', { title: item.title })}
        />
      ),
    },
    {
      ellipsis: true,
      key: 'template',
      title: t('agentTemplateCatalog.list.columns.template'),
      width: 240,
      render: (_, item) => (
        <div className={styles.identity}>
          <Avatar
            alt={item.title}
            avatar={item.avatar ?? undefined}
            background={item.backgroundColor ?? undefined}
            size={28}
          />
          <div className={styles.identityText}>
            <Text ellipsis strong>
              {item.title}
            </Text>
            <Text ellipsis type="secondary">
              {item.identifier}
            </Text>
          </div>
        </div>
      ),
    },
    {
      dataIndex: 'description',
      ellipsis: true,
      key: 'description',
      title: t('agentTemplateCatalog.list.columns.description'),
      width: 260,
      // The subtitle the user-side card shows; the prompt stands in when it is blank, exactly
      // like the card does, so the operator sees what will actually be rendered.
      render: (value: string, item) => (
        <Text ellipsis type={value ? undefined : 'secondary'}>
          {value || item.systemRole}
        </Text>
      ),
    },
    {
      dataIndex: 'tags',
      key: 'tags',
      title: t('agentTemplateCatalog.list.columns.tags'),
      width: 140,
      render: (value: string[]) => {
        if (value.length === 0) {
          return <Text type="secondary">{t('agentTemplateCatalog.list.tags.none')}</Text>;
        }
        // Keep every row exactly one line tall: only the first few tags are rendered,
        // the rest collapse into a "+N" tag that lists them on hover.
        const visible = value.slice(0, TAG_LIMIT);
        const overflow = value.slice(TAG_LIMIT);
        return (
          <div className={styles.tags}>
            {visible.map((tag) => (
              <Tag key={tag} size="small">
                {tag}
              </Tag>
            ))}
            {overflow.length > 0 ? (
              <Tooltip title={overflow.join(', ')}>
                <Tag size="small">{`+${overflow.length}`}</Tag>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      dataIndex: 'enabled',
      key: 'enabled',
      title: t('agentTemplateCatalog.list.columns.enabled'),
      width: 90,
      ...enumColumnFilter({
        options: [
          { label: t('agentTemplateCatalog.boolean.true'), value: 'true' },
          { label: t('agentTemplateCatalog.boolean.false'), value: 'false' },
        ],
        value: enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined,
      }),
      render: (value: boolean, item) => (
        <Switch
          aria-label={t('agentTemplateCatalog.list.columns.enabled')}
          checked={pendingEnabled[item.id] ?? value}
          disabled={!canUpdate || item.id in pendingEnabled}
          onChange={(next) => void handleToggle(item, next)}
        />
      ),
    },
    {
      dataIndex: 'source',
      ellipsis: true,
      key: 'source',
      title: t('agentTemplateCatalog.list.columns.source'),
      width: 100,
      render: (value: AdminAgentTemplateItem['source']) =>
        t(`agentTemplateCatalog.source.${value}` as never),
    },
    {
      dataIndex: 'updatedAt',
      ellipsis: true,
      key: 'updatedAt',
      title: t('agentTemplateCatalog.list.columns.updatedAt'),
      width: 160,
      render: (value: Date) => formatAdminDateTime(value),
    },
    {
      key: 'actions',
      title: t('agentTemplateCatalog.list.columns.actions'),
      width: 130,
      render: (_, item) => (
        <div className={styles.rowActions}>
          {canUpdate ? (
            <Button size="small" onClick={() => openEditor(item)}>
              {t('agentTemplateCatalog.actions.edit')}
            </Button>
          ) : null}
          {canDelete ? (
            <Button danger size="small" onClick={() => handleDelete(item)}>
              {t('agentTemplateCatalog.actions.delete')}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  // antd always prepends its own selection column. The placeholder pins it to just after the
  // drag handle instead, so the grip stays the first thing in every row.
  if (selectable) columns.splice(1, 0, Table.SELECTION_COLUMN);

  return columns;
};
