'use client';

import { memo, useCallback, useState } from 'react';

import {
  adminSkillsService,
  clearLastAdminSkillPublishOutcome,
  getLastAdminSkillPublishOutcome,
} from '@/enterprise/client/services/adminSkills';

import AdminDraftPublishBanner, {
  useAdminDraftBannerCopy,
} from '../shared/AdminDraftPublishBanner';

interface DraftPublishBannerProps {
  activeSkillId?: string | null;
  onPublished?: () => void;
}

const DraftPublishBanner = memo<DraftPublishBannerProps>(({ activeSkillId, onPublished }) => {
  const copy = useAdminDraftBannerCopy('aiSkillSettings');
  const [, setTick] = useState(0);
  const outcome = getLastAdminSkillPublishOutcome();
  const show =
    Boolean(outcome && !outcome.published) &&
    (!activeSkillId || outcome!.skillId === activeSkillId);

  const onRetry = useCallback(async () => {
    if (!outcome?.skillId) return;
    await adminSkillsService.publishNow({
      id: outcome.skillId,
      reason: 'Retry publish from admin skills banner',
    });
    onPublished?.();
    setTick((n) => n + 1);
  }, [onPublished, outcome?.skillId]);

  const onDismiss = useCallback(() => {
    clearLastAdminSkillPublishOutcome();
    setTick((n) => n + 1);
  }, []);

  return (
    <AdminDraftPublishBanner
      advancedCatalogHref="/admin/skills"
      advancedCatalogLabel={copy.advancedCatalog}
      message={copy.message}
      open={show}
      publishError={outcome?.publishError}
      retryLabel={copy.retry}
      defaultDescription={
        copy.defaultDescription ||
        'Publish requires a valid skill version. Add a version or fix validation, then retry.'
      }
      onDismiss={onDismiss}
      onRetry={onRetry}
    />
  );
});

DraftPublishBanner.displayName = 'AdminSkillDraftPublishBanner';

export default DraftPublishBanner;
