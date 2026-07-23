/**
 * Re-export enterprise flag types from the single runtime source of truth.
 * Do not re-declare keys here — see `packages/const/src/platform/featureFlags.ts`.
 */
export type {
  EnterpriseFeatureFlagKey,
  EnterpriseFeatureFlags,
} from '@/const/platform/featureFlags';
