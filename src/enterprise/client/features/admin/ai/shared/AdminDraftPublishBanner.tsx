'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  link: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

export interface AdminDraftPublishBannerProps {
  /** Advanced catalog deep link. */
  advancedCatalogHref: string;
  advancedCatalogLabel: string;
  /** Default description when publishError is empty. */
  defaultDescription: string;
  message: string;
  onDismiss: () => void;
  onRetry: () => Promise<void>;
  /** When false, banner is hidden. */
  open: boolean;
  publishError?: string | null;
  retryLabel: string;
}

/**
 * Shared draft-not-live banner for admin AI settings pages (providers / skills / connectors).
 * Callers own outcome state and retry side-effects so behavior stays domain-specific.
 */
const AdminDraftPublishBanner = memo<AdminDraftPublishBannerProps>(
  ({
    advancedCatalogHref,
    advancedCatalogLabel,
    defaultDescription,
    message,
    onDismiss,
    onRetry,
    open,
    publishError,
    retryLabel,
  }) => {
    const [retrying, setRetrying] = useState(false);

    const handleRetry = useCallback(async () => {
      setRetrying(true);
      try {
        await onRetry();
      } finally {
        setRetrying(false);
      }
    }, [onRetry]);

    if (!open) return null;

    return (
      <Alert
        closable
        showIcon
        message={message}
        type="warning"
        description={
          <Flexbox gap={8}>
            <Text type="secondary">{publishError || defaultDescription}</Text>
            <div className={styles.actions}>
              <Button loading={retrying} size="small" onClick={() => void handleRetry()}>
                {retryLabel}
              </Button>
              <Link className={styles.link} to={advancedCatalogHref}>
                {advancedCatalogLabel}
              </Link>
            </div>
          </Flexbox>
        }
        onClose={onDismiss}
      />
    );
  },
);

AdminDraftPublishBanner.displayName = 'AdminDraftPublishBanner';

export default AdminDraftPublishBanner;

/** i18n helper for pages that use the admin namespace. */
export const useAdminDraftBannerCopy = (
  namespace: 'aiProviderSettings' | 'aiSkillSettings' | 'aiConnectorSettings',
) => {
  const { t } = useTranslation('admin');
  return {
    advancedCatalog: t(`${namespace}.advancedCatalog` as never, {
      defaultValue: 'Advanced catalog management',
    }),
    defaultDescription: t(`${namespace}.draftBanner.desc` as never),
    message: t(`${namespace}.draftBanner.title` as never, {
      defaultValue: 'Changes saved as draft — not live yet',
    }),
    retry: t(`${namespace}.draftBanner.retry` as never, { defaultValue: 'Retry publish' }),
  };
};
