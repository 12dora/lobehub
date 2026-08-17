'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';

import { enumColumnFilter } from '../primitives/columnFilters';
import { formatTaskTemplateSchedule } from './schedule';
import { TaskTemplateDragHandle } from './SortableRow';
import type { AdminTaskTemplateItem } from './types';

const styles = createStaticStyles(({ css }) => ({
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
  t,
}: BuildTaskTemplateColumnsParams): TableColumnsType<AdminTaskTemplateItem> => [
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
    key: 'template',
    title: t('taskTemplateCatalog.list.columns.template'),
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
    key: 'category',
    title: t('taskTemplateCatalog.list.columns.category'),
    render: (value: AdminTaskTemplateItem['category']) =>
      t(`taskTemplateCatalog.category.${value}` as never),
  },
  {
    dataIndex: 'cronPattern',
    key: 'schedule',
    title: t('taskTemplateCatalog.list.columns.schedule'),
    render: (value: string) =>
      formatTaskTemplateSchedule(value, t as never, resolvedLanguage || language),
  },
  {
    dataIndex: 'connectors',
    key: 'connectors',
    title: t('taskTemplateCatalog.list.columns.connectors'),
    render: (value: AdminTaskTemplateItem['connectors']) =>
      value.length === 0 ? (
        <Text type="secondary">{t('taskTemplateCatalog.list.connectors.none')}</Text>
      ) : (
        <Flexbox horizontal gap={4} wrap="wrap">
          {value.map((connector) => (
            <Tag key={`${connector.source}:${connector.identifier}`}>{connector.identifier}</Tag>
          ))}
        </Flexbox>
      ),
  },
  {
    dataIndex: 'enabled',
    key: 'enabled',
    title: t('taskTemplateCatalog.list.columns.enabled'),
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
    key: 'source',
    title: t('taskTemplateCatalog.list.columns.source'),
    render: (value: AdminTaskTemplateItem['source']) =>
      t(`taskTemplateCatalog.source.${value}` as never),
  },
  {
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    title: t('taskTemplateCatalog.list.columns.updatedAt'),
    render: (value: Date) => new Date(value).toLocaleString(),
  },
  {
    key: 'actions',
    title: t('taskTemplateCatalog.list.columns.actions'),
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
