'use client';

import { memo, useCallback, useState } from 'react';

import {
  adminConnectorsService,
  clearLastAdminConnectorPublishOutcome,
  getLastAdminConnectorPublishOutcome,
} from '@/enterprise/client/services/adminConnectors';

import AdminDraftPublishBanner, {
  useAdminDraftBannerCopy,
} from '../shared/AdminDraftPublishBanner';

interface DraftPublishBannerProps {
  activeConnectorId?: string | null;
  onPublished?: () => void;
}

const DraftPublishBanner = memo<DraftPublishBannerProps>(({ activeConnectorId, onPublished }) => {
  const copy = useAdminDraftBannerCopy('aiConnectorSettings');
  const [, setTick] = useState(0);
  const outcome = getLastAdminConnectorPublishOutcome();
  const show =
    Boolean(outcome && !outcome.published) &&
    (!activeConnectorId || outcome!.connectorId === activeConnectorId);

  const onRetry = useCallback(async () => {
    if (!outcome?.connectorId) return;
    await adminConnectorsService.publishNow({
      id: outcome.connectorId,
      reason: 'Retry publish from admin connectors banner',
    });
    onPublished?.();
    setTick((n) => n + 1);
  }, [onPublished, outcome?.connectorId]);

  const onDismiss = useCallback(() => {
    clearLastAdminConnectorPublishOutcome();
    setTick((n) => n + 1);
  }, []);

  return (
    <AdminDraftPublishBanner
      advancedCatalogHref="/admin/connectors"
      advancedCatalogLabel={copy.advancedCatalog}
      message={copy.message}
      open={show}
      publishError={outcome?.publishError}
      retryLabel={copy.retry}
      defaultDescription={
        copy.defaultDescription ||
        'Publish requires enabled tools. Run Discover tools, enable at least one tool, then retry.'
      }
      onDismiss={onDismiss}
      onRetry={onRetry}
    />
  );
});

DraftPublishBanner.displayName = 'AdminConnectorDraftPublishBanner';

export default DraftPublishBanner;
