'use client';

import { Alert, Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { enumColumnFilter } from '../primitives/columnFilters';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { deriveSkillPermissions } from './controller';
import { refreshAdminSkillLists, useFetchAdminSkills } from './hooks/useAdminSkills';
import { useSkillListQuery } from './hooks/useSkillListQuery';
import { openCreateSkillModal } from './openCreateSkillModal';
import type { AdminSkillListItem } from './types';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  toolbar: css`
    justify-content: flex-start;
    width: 100%;
  `,
  toolbarSearch: css`
    flex: 0 1 260px;
    min-width: 180px;
    max-width: 320px;
  `,
}));

const SkillListPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { authMethod, permissions } = useAdminAccess();
  const { canCreate, canRead } = deriveSkillPermissions(permissions);
  const {
    cursorStack,
    distribution,
    enabledParam,
    filtered,
    handleTableChange,
    input,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    queryDraft,
    setQueryDraft,
    status,
  } = useSkillListQuery();
  const [committedCreateId, setCommittedCreateId] = useState<string | null>(null);
  const [createRefreshFailed, setCreateRefreshFailed] = useState(false);
  const [createRefreshRetrying, setCreateRefreshRetrying] = useState(false);
  const { data, error, isLoading, mutate } = useFetchAdminSkills(input, canRead);

  const columns = useMemo<TableColumnsType<AdminSkillListItem>>(
    () => [
      {
        key: 'skill',
        title: t('skillCatalog.list.columns.skill'),
        render: (_, item) => (
          <div className={styles.identity}>
            <Text ellipsis strong>
              {item.displayName}
            </Text>
            <Text code ellipsis type="secondary">
              {item.skillKey}
            </Text>
          </div>
        ),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('skillCatalog.list.columns.status'),
        render: (value: string) => <StatusBadge status={value} />,
        ...enumColumnFilter({
          options: (['draft', 'published', 'archived'] as const).map((value) => ({
            label: t(`skillCatalog.status.${value}` as never),
            value,
          })),
          value: status,
        }),
      },
      {
        dataIndex: 'source',
        key: 'source',
        title: t('skillCatalog.list.columns.source'),
        render: (value: AdminSkillListItem['source']) => t(`skillCatalog.source.${value}` as never),
      },
      {
        dataIndex: 'distribution',
        key: 'distribution',
        title: t('skillCatalog.list.columns.distribution'),
        render: (value: AdminSkillListItem['distribution']) => (
          <Tag>{t(`skillCatalog.distribution.${value}` as never)}</Tag>
        ),
        ...enumColumnFilter({
          options: (['mandatory', 'default', 'optional'] as const).map((value) => ({
            label: t(`skillCatalog.distribution.${value}` as never),
            value,
          })),
          value: distribution,
        }),
      },
      {
        dataIndex: 'enabled',
        key: 'enabled',
        title: t('skillCatalog.list.columns.enabled'),
        render: (value: boolean) => (
          <Tag color={value ? 'success' : 'default'}>
            {t(`skillCatalog.boolean.${value}` as never)}
          </Tag>
        ),
        ...enumColumnFilter({
          options: [
            { label: t('skillCatalog.boolean.true'), value: 'true' },
            { label: t('skillCatalog.boolean.false'), value: 'false' },
          ],
          value: enabledParam === 'true' || enabledParam === 'false' ? enabledParam : undefined,
        }),
      },
      {
        dataIndex: 'revision',
        key: 'revision',
        title: t('skillCatalog.list.columns.revision'),
      },
    ],
    [distribution, enabledParam, status, t],
  );

  const retryCreatedRefresh = async () => {
    if (!committedCreateId) return;
    setCreateRefreshRetrying(true);
    try {
      await refreshAdminSkillLists();
      const id = committedCreateId;
      setCommittedCreateId(null);
      setCreateRefreshFailed(false);
      navigate(`/admin/skills/${encodeURIComponent(id)}`);
    } catch {
      setCreateRefreshFailed(true);
    } finally {
      setCreateRefreshRetrying(false);
    }
  };

  return (
    <AdminPageTemplate
      description={t('skillCatalog.list.desc')}
      title={t('skillCatalog.list.title')}
      actions={
        canCreate ? (
          <Button
            disabled={Boolean(committedCreateId)}
            type="primary"
            onClick={() =>
              openCreateSkillModal({
                authMethod: authMethod ?? undefined,
                onSubmit: async (input) => {
                  const created = await adminSkillsService.create(input);
                  setCommittedCreateId(created.draft.id);
                  toast.success(t('skillCatalog.toast.created'));
                  try {
                    await refreshAdminSkillLists();
                    setCommittedCreateId(null);
                    setCreateRefreshFailed(false);
                    navigate(`/admin/skills/${encodeURIComponent(created.draft.id)}`);
                  } catch {
                    setCreateRefreshFailed(true);
                  }
                },
              })
            }
          >
            {t('skillCatalog.create.submit')}
          </Button>
        ) : null
      }
    >
      {createRefreshFailed ? (
        <Alert
          showIcon
          message={t('skillCatalog.create.refreshFailed')}
          type="warning"
          extra={
            <Button loading={createRefreshRetrying} onClick={() => void retryCreatedRefresh()}>
              {t('skillCatalog.actions.retry')}
            </Button>
          }
        />
      ) : null}
      <DataTable<AdminSkillListItem>
        columns={columns}
        dataSource={data?.items}
        error={Boolean(error) && !data}
        loading={isLoading && !data}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: Boolean(data?.nextCursor) && !error && !isLoading,
          hasPrevious: cursorStack.length > 0 && !isLoading,
          pageSize: limit,
          onNext: () => onNext(data?.nextCursor, isLoading),
          onPageSizeChange,
          onPrevious: () => onPrevious(isLoading),
        }}
        emptyDescription={
          filtered ? t('skillCatalog.list.empty.filtered') : t('skillCatalog.list.empty.default')
        }
        toolbar={
          <Flexbox horizontal className={styles.toolbar} data-testid="skill-list-toolbar">
            <div className={styles.toolbarSearch}>
              <Input
                allowClear
                aria-label={t('skillCatalog.list.filters.query')}
                placeholder={t('skillCatalog.list.filters.query')}
                style={{ width: '100%' }}
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
              />
            </div>
          </Flexbox>
        }
        onChange={handleTableChange}
        onRetry={() => void mutate()}
        onRowActivate={(item) => navigate(`/admin/skills/${encodeURIComponent(item.id)}`)}
      />
      {error && data ? (
        <Alert
          showIcon
          extra={<Button onClick={() => void mutate()}>{t('skillCatalog.actions.retry')}</Button>}
          message={t('skillCatalog.list.error.page')}
          type="error"
        />
      ) : null}
    </AdminPageTemplate>
  );
});

SkillListPage.displayName = 'AdminSkillListPage';

export default SkillListPage;
