'use client';

import { memo, useCallback } from 'react';

import {
  adminAiProviderService,
  clearLastAdminPublishOutcome,
  useAdminPublishOutcome,
} from '@/enterprise/client/services/adminAiInfraAdapter';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import AdminDraftPublishBanner, {
  useAdminDraftBannerCopy,
} from '../shared/AdminDraftPublishBanner';

/**
 * Shows when the last admin write left a draft unpublished (first-publish gate or soft fail).
 * Subscribes to the publish-outcome store so soft failures appear without remount.
 */
const DraftPublishBanner = memo(() => {
  const copy = useAdminDraftBannerCopy('aiProviderSettings');
  const activeId = useAiInfraStore((s) => s.activeAiProvider);
  const refreshList = useAiInfraStore((s) => s.refreshAiProviderList);
  const refreshDetail = useAiInfraStore((s) => s.refreshAiProviderDetail);
  const outcome = useAdminPublishOutcome(activeId);
  const show =
    Boolean(outcome && !outcome.published) && (!activeId || outcome!.providerId === activeId);

  const onRetry = useCallback(async () => {
    if (!outcome?.providerId) return;
    await adminAiProviderService.publishNow(outcome.providerId);
    await refreshList();
    await refreshDetail();
  }, [outcome?.providerId, refreshDetail, refreshList]);

  const onDismiss = useCallback(() => {
    clearLastAdminPublishOutcome(outcome?.providerId);
  }, [outcome?.providerId]);

  return (
    <AdminDraftPublishBanner
      advancedCatalogHref="/admin/ai/catalog/providers"
      advancedCatalogLabel={copy.advancedCatalog}
      message={copy.message}
      open={show}
      publishError={outcome?.publishError}
      retryLabel={copy.retry}
      defaultDescription={
        copy.defaultDescription ||
        'Publish requires credentials, at least one enabled model, and a successful connection test.'
      }
      onDismiss={onDismiss}
      onRetry={onRetry}
    />
  );
});

DraftPublishBanner.displayName = 'DraftPublishBanner';

export default DraftPublishBanner;
