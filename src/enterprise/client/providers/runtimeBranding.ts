import { BUILT_IN_RUNTIME_BRANDING as BUILT_IN_BRANDING } from '@lobechat/business-const';

import {
  resolveRuntimeBranding as resolveBranding,
  type RuntimeBranding,
} from '@/types/platform/branding';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

export type { RuntimeBranding } from '@/types/platform/branding';

export const BUILT_IN_RUNTIME_BRANDING: RuntimeBranding = { ...BUILT_IN_BRANDING };

/** Field-by-field fallback prevents partial Published values from creating blank branding. */
export const resolveRuntimeBranding = (snapshot: PlatformPublicSnapshot): RuntimeBranding => {
  return resolveBranding(snapshot.branding, BUILT_IN_RUNTIME_BRANDING);
};
