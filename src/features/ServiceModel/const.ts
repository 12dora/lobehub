import type { EffortControlKey } from '@lobechat/model-runtime';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';

export const EMPTY_EFFORT_METAS: Partial<Record<EffortControlKey, PlatformSettingMetaState>> = {};

/** Default-assistant model + effort sit on one row; they are gated independently. */
export const ROW_STYLE = { width: 'min(100%, 448px)' } as const;
export const MODEL_SELECT_STYLE = { minWidth: 0, width: '100%' } as const;
