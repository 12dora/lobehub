'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';

import StatusBadge from '../../primitives/StatusBadge';
import { useFetchAdminAiProviderRevisions } from '../hooks/useAdminAiCatalog';

const styles = createStaticStyles(({ css }) => ({
  revision: css`
    display: grid;
    grid-template-columns: 100px 120px minmax(180px, 1fr) auto;
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 800px) {
      grid-template-columns: 1fr;
    }
  `,
  revisions: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
}));

export interface ProviderRevisionsPanelProps {
  baseRevision: number;
  canPublish: boolean;
  canRead: boolean;
  disabled?: boolean;
  onRollback?: (revision: number) => void;
  providerId: string;
}

const ProviderRevisionsPanel = memo<ProviderRevisionsPanelProps>(
  ({ baseRevision, canPublish, canRead, disabled, onRollback, providerId }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
    const [revisionCursorStack, setRevisionCursorStack] = useState<number[]>([]);
    const revisionCursor = revisionCursorStack.at(-1);
    const revisions = useFetchAdminAiProviderRevisions(providerId, canRead, revisionCursor);

    return (
      <section className={styles.revisions}>
        <Flexbox gap={4}>
          <Text strong>{t('aiCatalog.revisions.title')}</Text>
          <Text type="secondary">{t('aiCatalog.revisions.desc')}</Text>
        </Flexbox>
        {revisions.error ? (
          <Alert
            showIcon
            message={t('aiCatalog.revisions.error')}
            type="error"
            extra={
              <Button onClick={() => void revisions.mutate()}>
                {t('aiCatalog.revisions.retry')}
              </Button>
            }
          />
        ) : revisions.isLoading && !revisions.data ? (
          <div aria-label={t('aiCatalog.revisions.loading')} role="status">
            <Flexbox gap={0}>
              {[0, 1, 2].map((row) => (
                <div className={styles.revision} key={row}>
                  <Skeleton.Button
                    active={!reduceMotion}
                    size="small"
                    style={{ height: 16, width: 48 }}
                  />
                  <Skeleton.Button
                    active={!reduceMotion}
                    size="small"
                    style={{ height: 20, width: 72 }}
                  />
                  <Skeleton
                    active={!reduceMotion}
                    paragraph={{ rows: 1, width: '80%' }}
                    title={false}
                  />
                </div>
              ))}
            </Flexbox>
          </div>
        ) : revisions.data?.items.length ? (
          <>
            {revisions.data.items.map((revision) => (
              <div className={styles.revision} key={revision.revision}>
                <Text>{t('aiCatalog.revisions.row', { revision: revision.revision })}</Text>
                <StatusBadge status={revision.status} />
                <Flexbox gap={2}>
                  <Text>{revision.comment || t('aiCatalog.revisions.noComment')}</Text>
                  <Text type="secondary">{formatAdminDateTime(revision.publishedAt)}</Text>
                </Flexbox>
                {canPublish &&
                revision.status === 'published' &&
                revision.revision !== baseRevision ? (
                  <Button
                    danger
                    disabled={disabled}
                    onClick={() => onRollback?.(revision.revision)}
                  >
                    {t('aiCatalog.actions.rollback.label')}
                  </Button>
                ) : null}
              </div>
            ))}
            <Flexbox horizontal gap={8} justify="flex-end">
              <Button
                disabled={revisionCursorStack.length === 0}
                onClick={() => setRevisionCursorStack((current) => current.slice(0, -1))}
              >
                {t('aiCatalog.revisions.previous')}
              </Button>
              <Button
                disabled={!revisions.data.nextCursor}
                onClick={() => {
                  const nextCursor = revisions.data?.nextCursor;
                  if (!nextCursor) return;
                  setRevisionCursorStack((current) => [...current, nextCursor]);
                }}
              >
                {t('aiCatalog.revisions.next')}
              </Button>
            </Flexbox>
          </>
        ) : (
          <Text type="secondary">{t('aiCatalog.revisions.empty')}</Text>
        )}
      </section>
    );
  },
);

ProviderRevisionsPanel.displayName = 'AdminAiProviderRevisionsPanel';

export default ProviderRevisionsPanel;
