'use client';

import { Alert, Empty, Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';

import ConnectorCard from './ConnectorCard';
import type { UserConnectorListInput } from './types';
import { useConnectorAuthorizationActions } from './useConnectorAuthorizationActions';
import { useFetchManagedConnectors } from './useManagedConnectors';

const DEFAULT_LIMIT = 50;

const styles = createStaticStyles(({ css }) => ({
  list: css`
    width: 100%;
    max-width: 960px;
    margin-inline: auto;
    padding-block: 24px 48px;
  `,
  toolbar: css`
    flex-wrap: wrap;
  `,
}));

const PlatformConnectorAuthorization = memo(() => {
  const { t } = useTranslation('setting');
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('connector_q') ?? '';
  const [searchDraft, setSearchDraft] = useState(query);
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo<UserConnectorListInput>(
    () => ({ cursor: cursor ?? undefined, limit, query: query || undefined }),
    [cursor, limit, query],
  );
  const { data, error, isLoading, mutate } = useFetchManagedConnectors(input);
  const { authorize, busyConnectorId, disconnect, feedback } = useConnectorAuthorizationActions();

  const commitSearch = () => {
    const next = new URLSearchParams(searchParams);
    const normalized = searchDraft.trim();
    if (normalized) next.set('connector_q', normalized);
    else next.delete('connector_q');
    setSearchParams(next, { replace: true });
    setCursorStack([]);
  };

  return (
    <Flexbox className={styles.list} gap={16}>
      <Flexbox gap={4}>
        <Text strong as={'h1'} fontSize={24}>
          {t('platformConnectors.title')}
        </Text>
        <Text type={'secondary'}>{t('platformConnectors.description')}</Text>
      </Flexbox>

      <Alert
        showIcon
        description={t('platformConnectors.policy.description')}
        message={t('platformConnectors.policy.title')}
        type={'info'}
      />

      <Flexbox horizontal className={styles.toolbar} gap={8}>
        <Input
          allowClear
          aria-label={t('platformConnectors.search.placeholder')}
          placeholder={t('platformConnectors.search.placeholder')}
          style={{ minWidth: 240 }}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          onPressEnter={commitSearch}
          onClear={() => {
            setSearchDraft('');
            const next = new URLSearchParams(searchParams);
            next.delete('connector_q');
            setSearchParams(next, { replace: true });
            setCursorStack([]);
          }}
        />
        <Button onClick={commitSearch}>{t('platformConnectors.search.action')}</Button>
        <Select
          aria-label={t('platformConnectors.pagination.pageSize')}
          options={[20, 50, 100].map((value) => ({ label: String(value), value }))}
          value={limit}
          onChange={(value) => {
            setLimit(Number(value));
            setCursorStack([]);
          }}
        />
      </Flexbox>

      <AsyncBoundary
        data={data}
        error={error}
        isEmpty={!error && data?.items.length === 0}
        isLoading={isLoading}
        empty={
          <Empty
            description={
              query ? t('platformConnectors.empty.filtered') : t('platformConnectors.empty.default')
            }
          />
        }
        onRetry={() => void mutate()}
      >
        <Flexbox gap={12}>
          {data?.items.map((connector) => (
            <ConnectorCard
              busy={busyConnectorId === connector.id}
              connector={connector}
              feedback={feedback}
              key={connector.id}
              onAuthorize={(id) => void authorize(id)}
              onDisconnect={(id) => void disconnect(id)}
            />
          ))}
        </Flexbox>
      </AsyncBoundary>

      {data && (cursorStack.length > 0 || data.nextCursor) ? (
        <Flexbox horizontal gap={8} justify={'flex-end'}>
          <Button
            disabled={cursorStack.length === 0}
            onClick={() => setCursorStack((current) => current.slice(0, -1))}
          >
            {t('platformConnectors.pagination.previous')}
          </Button>
          <Button
            disabled={!data.nextCursor}
            onClick={() => {
              if (data.nextCursor) setCursorStack((current) => [...current, data.nextCursor]);
            }}
          >
            {t('platformConnectors.pagination.next')}
          </Button>
        </Flexbox>
      ) : null}
    </Flexbox>
  );
});

PlatformConnectorAuthorization.displayName = 'PlatformConnectorAuthorization';

export default PlatformConnectorAuthorization;
