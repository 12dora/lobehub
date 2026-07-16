'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import StatusBadge from './StatusBadge';

const styles = createStaticStyles(({ css }) => ({
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-end: 16px;
  `,
}));

export interface RevisionBannerProps {
  conflict?: boolean;
  draftRevision?: string | number | null;
  onRefresh?: () => void;
  publishedRevision?: string | number | null;
  status?: string | null;
}

/**
 * Draft vs published revision strip for publish-style admin resources.
 */
const RevisionBanner = memo<RevisionBannerProps>(
  ({ status, draftRevision, publishedRevision, conflict, onRefresh }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.root}>
        {conflict ? (
          <Alert
            showIcon
            closable={false}
            message={t('primitives.revision.conflict')}
            type="warning"
            extra={
              onRefresh ? (
                <Button size="small" onClick={onRefresh}>
                  {t('primitives.revision.refresh')}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        <Flexbox horizontal align="center" className={styles.meta} gap={12}>
          {status ? <StatusBadge status={status} /> : null}
          {draftRevision != null && draftRevision !== '' ? (
            <Text type="secondary">
              {t('primitives.revision.draft')}: {String(draftRevision)}
            </Text>
          ) : null}
          {publishedRevision != null && publishedRevision !== '' ? (
            <Text type="secondary">
              {t('primitives.revision.published')}: {String(publishedRevision)}
            </Text>
          ) : null}
        </Flexbox>
      </div>
    );
  },
);

RevisionBanner.displayName = 'AdminRevisionBanner';

export default RevisionBanner;
