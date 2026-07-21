'use client';

import { memo } from 'react';

import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/slices/settings/selectors';

import ImageFormView from './ImageFormView';

const ImageSettings = memo(() => {
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const defaultImageNumMeta = usePlatformSettingMeta('image.defaultImageNum');

  const imageSettings = useUserStore(settingsSelectors.currentImageSettings);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);

  return (
    <ImageFormView
      canManage={canManageServiceModel}
      disabledReason={reason}
      isInit={isUserStateInit}
      meta={defaultImageNumMeta}
      value={imageSettings}
      onChange={(values) => setSettings({ image: values })}
    />
  );
});

ImageSettings.displayName = 'ImageSettings';

export default ImageSettings;
