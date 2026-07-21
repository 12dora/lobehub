'use client';

import type { UserTTSConfig } from '@lobechat/types';
import isEqual from 'fast-deep-equal';
import { memo } from 'react';

import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

import OpenAIFormView from './OpenAIFormView';

const OpenAI = memo(() => {
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const { tts } = useUserStore(settingsSelectors.currentSettings, isEqual);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);
  const ttsModelMeta = usePlatformSettingMeta('tts.openAI.ttsModel');

  return (
    <OpenAIFormView
      canManage={canManageServiceModel}
      disabledReason={reason}
      isInit={isUserStateInit}
      ttsModelMeta={ttsModelMeta}
      value={tts ?? {}}
      onChange={(values) => setSettings({ tts: values as UserTTSConfig })}
    />
  );
});

export default OpenAI;
