import type { InstanceStatusView } from '@/types/platform/networkProxy';

/**
 * Whether smart routing has the rule data it needs — with "we could not read it" kept apart from
 * "it is not installed".
 *
 * Collapsing the two makes an unreachable status query look like a fresh, unconfigured
 * deployment: the panel would announce missing rule data and offer to install it while it is in
 * fact holding no information at all (DESIGN.md, 确定性).
 */
export type NetworkProxyGeodataState = 'missing' | 'ready' | 'unknown';

const GEODATA_KINDS = ['geoip', 'geosite'] as const;

/** `instance` is the row answering for this deployment, or `undefined` when none has reported. */
export const deriveGeodataState = (
  instance: InstanceStatusView | undefined,
): NetworkProxyGeodataState => {
  if (!instance) return 'unknown';
  return GEODATA_KINDS.every((kind) =>
    Boolean(instance.artifacts.find((item) => item.kind === kind)?.installed),
  )
    ? 'ready'
    : 'missing';
};
