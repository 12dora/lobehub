/**
 * Default Milestone A–F release plan with firstEnable ↔ command binding.
 */
import type { AllowlistedCommandId, HighRiskCapability } from './constants';
import { type ReleasePlan, releasePlanSchema } from './schemas';

const sharedMetrics = [
  'error-rate',
  'p95-latency-ms',
  'auth-failure-rate',
  'job-failure-rate',
] as const;

const HIGH_RISK_ENABLE: Record<
  Exclude<HighRiskCapability, 'none'>,
  { enable: AllowlistedCommandId; disable: AllowlistedCommandId }
> = {
  'branding-cutover': {
    enable: 'flag-enable-branding-cutover',
    disable: 'flag-disable-branding-cutover',
  },
  'connector-shared-credentials': {
    enable: 'flag-enable-connector-shared-credentials',
    disable: 'flag-disable-connector-shared-credentials',
  },
  'default-inbox': {
    enable: 'flag-enable-default-inbox',
    disable: 'flag-disable-default-inbox',
  },
  'oidc': {
    enable: 'flag-enable-oidc',
    disable: 'flag-disable-oidc',
  },
};

export const buildDefaultReleasePlan = (input: {
  candidateGitSha: string;
  releaseId: string;
}): ReleasePlan => {
  const stop = (id: string, metricId: (typeof sharedMetrics)[number], threshold: number) => ({
    comparator: 'gt' as const,
    id,
    metricId,
    threshold,
  });

  const window = (
    id:
      'milestone-a' | 'milestone-b' | 'milestone-c' | 'milestone-d' | 'milestone-e' | 'milestone-f',
    order: number,
    firstEnableCapability: HighRiskCapability,
    ownerRole: string,
    monitorDurationMinutes: number,
    prerequisites: string[],
  ) => {
    const isHighRisk = firstEnableCapability !== 'none';
    const pair = isHighRisk ? HIGH_RISK_ENABLE[firstEnableCapability] : null;
    return {
      approval: 'required' as const,
      firstEnableCapability,
      forwardCommandIds: isHighRisk
        ? [pair!.enable, 'monitor-release-window' as const]
        : (['release-window-activate', 'monitor-release-window'] as AllowlistedCommandId[]),
      id,
      metricIds: [...sharedMetrics],
      monitorDurationMinutes,
      order,
      ownerRole,
      prerequisites,
      rollbackCommandIds: isHighRisk
        ? [pair!.disable]
        : (['release-window-rollback'] as AllowlistedCommandId[]),
      rollbackVerificationCommandIds: ['release-window-verify-rollback'] as AllowlistedCommandId[],
      stopConditions: [stop(`${id}-error-rate`, 'error-rate', isHighRisk ? 0.005 : 0.01)],
    };
  };

  const plan = {
    candidateGitSha: input.candidateGitSha,
    releaseId: input.releaseId,
    schemaVersion: 1 as const,
    windows: [
      window('milestone-a', 1, 'none', 'platform-sre', 60, ['preflight-passed']),
      window('milestone-b', 2, 'none', 'platform-admin', 60, ['milestone-a-stable']),
      window('milestone-c', 3, 'connector-shared-credentials', 'security-admin', 120, [
        'milestone-b-stable',
      ]),
      window('milestone-d', 4, 'default-inbox', 'product-ops', 120, ['milestone-c-stable']),
      window('milestone-e', 5, 'oidc', 'identity-admin', 180, ['milestone-d-stable']),
      window('milestone-f', 6, 'branding-cutover', 'release-manager', 240, [
        'milestone-e-stable',
        'dr-drill-passed',
      ]),
    ],
  };
  return releasePlanSchema.parse(plan);
};
