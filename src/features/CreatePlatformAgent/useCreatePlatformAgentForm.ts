import type { RemoteHeterogeneousAgentType } from '@lobechat/heterogeneous-agents';
import { useModalContext } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { lambdaQuery } from '@/libs/trpc/client';
import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

import { useDevicePlatformProbe } from './useDevicePlatformProbe';
import { getPlatformTitle, isDeviceStepNextDisabled } from './utils';

interface UseCreatePlatformAgentFormParams {
  groupId?: string;
  visibility?: 'private' | 'public';
}

/** Drives the three-step wizard: platform choice, device binding and the final agent write. */
export const useCreatePlatformAgentForm = ({
  groupId,
  visibility,
}: UseCreatePlatformAgentFormParams) => {
  const { close, setCanDismissByClickOutside } = useModalContext();
  const navigate = useNavigate();
  const storeCreateAgent = useAgentStore((s) => s.createAgent);
  const refreshAgentList = useHomeStore((s) => s.refreshAgentList);

  // Creating from a workspace context: the new agent inherits the active
  // workspace's scope (server-side), so the device picker must restrict to
  // workspace devices — a workspace agent bound to a personal device is
  // unreachable to other members and the server rejects the write.
  const activeWorkspaceId = useActiveWorkspaceId();
  const restrictToWorkspaceDevices = Boolean(activeWorkspaceId);

  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState<RemoteHeterogeneousAgentType>('openclaw');
  const [agentName, setAgentName] = useState('');
  const [agentDescription, setAgentDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const {
    agentProfile,
    capabilityResult,
    checkingCapability,
    deviceId,
    fetchingProfile,
    handleDeviceChange,
    reset: resetDeviceProbe,
  } = useDevicePlatformProbe(platform);

  useEffect(() => {
    setCanDismissByClickOutside(!creating);
  }, [creating, setCanDismissByClickOutside]);

  const {
    data: devices,
    isLoading: loadingDevices,
    isFetching: fetchingDevices,
    refetch: refetchDevices,
  } = lambdaQuery.device.listDevices.useQuery(undefined, {
    staleTime: 0,
  });

  const selectedPlatformName = getPlatformTitle(platform);

  // Autofill only empty fields on step/profile transitions. Functional updaters keep the
  // latest name/description without listing them as deps (which would re-fill after clear).
  useEffect(() => {
    if (step !== 2) return;
    if (agentProfile !== null) {
      setAgentName((current) => current || (agentProfile.title ?? selectedPlatformName));
      setAgentDescription((current) => current || (agentProfile.description ?? ''));
    } else if (!fetchingProfile) {
      setAgentName((current) => current || selectedPlatformName);
    }
  }, [step, agentProfile, fetchingProfile, selectedPlatformName]);

  const handlePlatformChange = useCallback(
    (type: RemoteHeterogeneousAgentType) => {
      setPlatform(type);
      resetDeviceProbe();
    },
    [resetDeviceProbe],
  );

  const handleNext = useCallback(() => {
    setStep((s) => s + 1);
  }, []);

  const handleBack = useCallback(() => {
    setStep((s) => s - 1);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!deviceId) return;
    setCreating(true);
    try {
      const title = agentName.trim() || selectedPlatformName;
      const result = await storeCreateAgent({
        config: {
          agencyConfig: {
            boundDeviceId: deviceId,
            heterogeneousProvider: {
              type: platform,
            },
          },
          avatar: agentProfile?.avatar || undefined,
          description: agentDescription.trim() || undefined,
          title,
        },
        groupId,
        visibility,
      });
      await refreshAgentList();
      close();
      navigate(`/agent/${result.agentId}`);
    } finally {
      setCreating(false);
    }
  }, [
    deviceId,
    agentName,
    agentDescription,
    agentProfile,
    platform,
    groupId,
    visibility,
    storeCreateAgent,
    refreshAgentList,
    close,
    navigate,
    selectedPlatformName,
  ]);

  return {
    agentDescription,
    agentName,
    agentProfile,
    capabilityResult,
    checkingCapability,
    creating,
    deviceId,
    devices,
    deviceStepNextDisabled: isDeviceStepNextDisabled({
      capabilityResult,
      checkingCapability,
      deviceId,
    }),
    fetchingProfile,
    handleBack,
    handleCreate,
    handleDeviceChange,
    handleNext,
    handlePlatformChange,
    isRefreshingDevices: loadingDevices || fetchingDevices,
    platform,
    refetchDevices,
    restrictToWorkspaceDevices,
    selectedPlatformName,
    setAgentDescription,
    setAgentName,
    step,
  };
};
