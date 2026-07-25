'use client';

import isEqual from 'fast-deep-equal';
import { memo } from 'react';

import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { MemoryFormView } from '@/features/SettingsForms';
import { usePermission } from '@/hooks/usePermission';
import { useSaveState } from '@/hooks/useSaveState';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

/**
 * User-settings wrapper for memory preferences. Store / meta / permission wiring stays here.
 */
const MemorySetting = memo(() => {
  const { allowed: canManageMemory, reason } = usePermission('manage_settings');
  const { memory } = useUserStore(settingsSelectors.currentSettings, isEqual);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);
  const saveState = useSaveState();
  const enabledMeta = usePlatformSettingMeta('memory.enabled');
  const effortMeta = usePlatformSettingMeta('memory.effort');

  return (
    <MemoryFormView
      canManage={canManageMemory}
      disabledReason={reason}
      effortMeta={effortMeta}
      enabledMeta={enabledMeta}
      isInit={isUserStateInit}
      saveState={saveState}
      value={memory ?? {}}
      onChange={(patch) => setSettings({ memory: patch })}
    />
  );
});

export default MemorySetting;
