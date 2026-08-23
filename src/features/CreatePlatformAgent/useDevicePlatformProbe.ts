import type { RemoteHeterogeneousAgentType } from '@lobechat/heterogeneous-agents';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { deviceService } from '@/services/device';

import type { AgentProfile, CapabilityResult } from './types';

/**
 * Probes the picked device for the selected platform: whether the CLI is installed
 * (capability) and what agent profile it advertises. Both probes are platform-specific,
 * so the caller must `reset()` whenever the platform changes.
 */
export const useDevicePlatformProbe = (platform: RemoteHeterogeneousAgentType) => {
  const { t } = useTranslation('chat');
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [fetchingProfile, setFetchingProfile] = useState(false);
  const [capabilityResult, setCapabilityResult] = useState<CapabilityResult | undefined>(undefined);
  const [checkingCapability, setCheckingCapability] = useState(false);

  const checkCapability = useCallback(
    async (dId: string) => {
      setCheckingCapability(true);
      setCapabilityResult(undefined);
      try {
        const result = await deviceService.checkCapability({
          deviceId: dId,
          platform,
        });
        setCapabilityResult(result);
      } catch {
        setCapabilityResult({ available: false, reason: t('platformAgent.create.checkFailed') });
      } finally {
        setCheckingCapability(false);
      }
    },
    [platform, t],
  );

  const fetchProfile = useCallback(
    async (dId: string) => {
      setFetchingProfile(true);
      setAgentProfile(null);
      try {
        const profile = await deviceService.getAgentProfile({
          deviceId: dId,
          platform,
        });
        setAgentProfile(profile);
      } catch {
        setAgentProfile({});
      } finally {
        setFetchingProfile(false);
      }
    },
    [platform],
  );

  const handleDeviceChange = useCallback(
    (dId: string) => {
      setDeviceId(dId);
      void checkCapability(dId);
      void fetchProfile(dId);
    },
    [checkCapability, fetchProfile],
  );

  // Capability is platform-specific; stale results from the previous platform
  // must not carry over.
  const reset = useCallback(() => {
    setDeviceId(undefined);
    setCapabilityResult(undefined);
    setAgentProfile(null);
  }, []);

  return {
    agentProfile,
    capabilityResult,
    checkingCapability,
    deviceId,
    fetchingProfile,
    handleDeviceChange,
    reset,
  };
};
