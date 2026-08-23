import {
  REMOTE_HETEROGENEOUS_AGENT_CONFIGS,
  type RemoteHeterogeneousAgentType,
} from '@lobechat/heterogeneous-agents';
import type { DeviceListItem } from '@lobechat/types';
import type { TFunction } from 'i18next';

import type { CapabilityResult, PlatformDef } from './types';

const COMING_SOON_PLATFORMS = new Set<RemoteHeterogeneousAgentType>(['amp', 'opencode']);

export const buildPlatformDefs = (t: TFunction<'chat'>): PlatformDef[] =>
  REMOTE_HETEROGENEOUS_AGENT_CONFIGS.map((c) => ({
    comingSoon: COMING_SOON_PLATFORMS.has(c.type),
    desc: t(`platformAgent.create.desc.${c.type}`),
    name: c.title,
    type: c.type,
  }));

export const getPlatformTitle = (type: RemoteHeterogeneousAgentType): string =>
  REMOTE_HETEROGENEOUS_AGENT_CONFIGS.find((c) => c.type === type)!.title;

/**
 * Only online devices can host an agent. A workspace agent additionally inherits the
 * workspace scope server-side, so personal devices are unreachable to other members.
 */
export const selectSelectableDevices = (
  devices: DeviceListItem[] | undefined,
  restrictToWorkspaceDevices: boolean,
): DeviceListItem[] =>
  (devices ?? []).filter(
    (d) => d.online && (!restrictToWorkspaceDevices || d.scope === 'workspace'),
  );

/**
 * The gateway reports an outdated CLI through this phrase; it earns an upgrade hint
 * rather than the generic "not installed" error tag.
 */
export const isCapabilityVersionTooLow = (result: CapabilityResult | undefined): boolean =>
  Boolean(result?.reason?.includes('is not available on this device'));

export const isDeviceStepNextDisabled = ({
  capabilityResult,
  checkingCapability,
  deviceId,
}: {
  capabilityResult: CapabilityResult | undefined;
  checkingCapability: boolean;
  deviceId: string | undefined;
}): boolean => !deviceId || checkingCapability || capabilityResult?.available === false;
