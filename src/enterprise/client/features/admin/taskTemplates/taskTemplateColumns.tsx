'use client';

import { Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { Table } from 'antd';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';

import { enumColumnFilter } from '../primitives/columnFilters';
import { formatAdminDateTime } from '../users/utils';
import { formatTaskTemplateSchedule } from './schedule';
import { TaskTemplateDragHandle } from './SortableRow';
import type { AdminTaskTemplateItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  connectors: css`
    overflow: hidden;
    display: flex;
    gap: 4px;
    align-items: center;

    min-width: 0;
  `,
  identity: css`
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
}));

/** Connector tags rendered inline before the rest collapses into a "+N" tag. */
const CONNECTOR_TAG_LIMIT = 2;

export interface BuildTaskTemplateColumnsParams {
  canDelete: boolean;
  canUpdate: boolean;
  enabledParam: string | null;
  handleDelete: (item: AdminTaskTemplateItem) => void;
  handleToggle: (item: AdminTaskTemplateItem, next: boolean) => void;
  language: string;
  openEditor: (item?: AdminTaskTemplateItem) => void;
  pendingEnabled: Record<string, boolean>;
  resolvedLanguage?: string;
  /** Render the bulk-selection checkbox column right after the drag handle. */
  selectable: boolean;
  t: TFunction<'admin'>;
}

export const buildTaskTemplateColumns = ({
  canDelete,
  canUpdate,
  enabledParam,
  handleDelete,
  handleToggle,
  language,
  openEditor,
  pendingEnabled,
  resolvedLanguage,
  selectable,
  t,
}: BuildTaskTemplateColumnsParams): TableColumnsType<AdminTaskTemplateItem> => {
  const columns: TableColumnsType<AdminTaskTemplateItem> = [
    {
      key: 'order',
      title: t('taskTemplateCatalog.list.columns.order'),
      width: 56,
      render: (_, item) => (
        <TaskTemplateDragHandle
          label={t('taskTemplateCatalog.list.dragHandle', { title: item.title })}
        />
      ),
    },
    {
      ellipsis: true,
      key: 'template',
      title: t('taskTemplateCatalog.list.columns.template'),
      width: 240,
      render: (_, item) => (
        <div className={styles.identity}>
          <Text ellipsis strong>
            {item.title}
          </Text>
          <Text ellipsis type="secondary">
            {item.description || item.identifier}
          </Text>
        </div>
      ),
    },
    {
      dataIndex: 'category',
      ellipsis: true,
      key: 'category',
      title: t('taskTemplateCatalog.list.columns.category'),
      width: 100,
      render: (value: AdminTaskTemplateItem['category']) =>
        t(`taskTemplateCatalog.category.${value}` as never),
    },
    {
      dataIndex: 'cronPattern',
      ellipsis: true,
      key: 'schedule',
      title: t('taskTemplateCatalog.list.columns.schedule'),
      width: 140,
      render: (value: string) =>
        formatTaskTemplateSchedule(value, t as never, resolvedLanguage || language),
    },
    {
      dataIndex: 'connectors',
      key: 'connectors',
      title: t('taskTemplateCatalog.list.columns.connectors'),
      // Most templates declare no connector at all, so the column only ever needs room for
      // the header plus a tag or two — 160 was dead space pushing the useful columns out.
      width: 110,
      render: (value: AdminTaskTemplateItem['connectors']) => {
        if (value.length === 0) {
          return <Text type="secondary">{t('taskTemplateCatalog.list.connectors.none')}</Text>;
        }
        // Keep every row exactly one line tall: only the first few tags are rendered,
        // the rest collapse into a "+N" tag that lists them on hover.
        const visible = value.slice(0, CONNECTOR_TAG_LIMIT);
        const overflow = value.slice(CONNECTOR_TAG_LIMIT);
        return (
          <div className={styles.connectors}>
            {visible.map((connector) => (
              <Tag key={`${connector.source}:${connector.identifier}`} size="small">
                {connector.identifier}
              </Tag>
            ))}
            {overflow.length > 0 ? (
              <Tooltip title={overflow.map((connector) => connector.identifier).join(', ')}>
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
      title: t('taskTemplateCatalog.list.columns.enabled'),
      width: 90,
      ...enumColumnFilter({
        options: [
          { label: t('taskTemplateCatalog.boolean.true'), value: 'true' },
          { label: t('taskTemplateCatalog.boolean.false'), value: 'false' },
        ],
        value: enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined,
      }),
      render: (value: boolean, item) => (
        <Switch
          aria-label={t('taskTemplateCatalog.list.columns.enabled')}
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
      title: t('taskTemplateCatalog.list.columns.source'),
      width: 100,
      render: (value: AdminTaskTemplateItem['source']) =>
        t(`taskTemplateCatalog.source.${value}` as never),
    },
    {
      dataIndex: 'updatedAt',
      ellipsis: true,
      key: 'updatedAt',
      title: t('taskTemplateCatalog.list.columns.updatedAt'),
      width: 160,
      render: (value: Date) => formatAdminDateTime(value),
    },
    {
      key: 'actions',
      title: t('taskTemplateCatalog.list.columns.actions'),
      width: 130,
      render: (_, item) => (
        <div className={styles.rowActions}>
          {canUpdate ? (
            <Button size="small" onClick={() => openEditor(item)}>
              {t('taskTemplateCatalog.actions.edit')}
            </Button>
          ) : null}
          {canDelete ? (
            <Button danger size="small" onClick={() => handleDelete(item)}>
              {t('taskTemplateCatalog.actions.delete')}
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
