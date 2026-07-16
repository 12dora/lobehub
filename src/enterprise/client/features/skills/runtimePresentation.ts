import type { PlatformPublishedSkillCatalog } from '@/types/platform/skills';

type PlatformSkillRuntimeStatus = 'error' | 'loading' | 'ready' | 'unmanaged';

interface SkillRuntimeSources<TBuiltin, TMarket, TUser> {
  builtin: TBuiltin[];
  market: TMarket[];
  platform: PlatformPublishedSkillCatalog | null;
  user: TUser[];
}

/**
 * Keep ordinary surfaces aligned with the runtime fail-closed boundary.
 * Loading/error must never reveal stale legacy or stale platform candidates.
 */
export const selectSkillRuntimeSources = <TBuiltin, TMarket, TUser>(params: {
  builtin: TBuiltin[];
  market: TMarket[];
  platform: PlatformPublishedSkillCatalog | null;
  status: PlatformSkillRuntimeStatus;
  user: TUser[];
}): SkillRuntimeSources<TBuiltin, TMarket, TUser> => {
  if (params.status === 'unmanaged') {
    return { builtin: params.builtin, market: params.market, platform: null, user: params.user };
  }
  if (params.status === 'ready') {
    return { builtin: [], market: [], platform: params.platform, user: [] };
  }
  return { builtin: [], market: [], platform: null, user: [] };
};
