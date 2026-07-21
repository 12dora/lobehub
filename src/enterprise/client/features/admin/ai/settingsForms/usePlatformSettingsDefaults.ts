'use client';

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';

import {
  buildDefaultAgentFromPolicies,
  buildImageFromPolicies,
  buildMemoryFromPolicies,
  buildSystemAgentFromPolicies,
  buildTtsFromPolicies,
  isUnpublishedSettingsDraftError,
  systemAgentPatch,
} from './platformDefaults';

const SWR_KEY = ['admin', 'settings', 'platform-defaults'] as const;

/**
 * Load published platform settings and apply path patches via applyImmediate.
 */
export const usePlatformSettingsDefaults = () => {
  const { permissions } = useAdminAccess();
  const canUpdate = permissions.includes(PLATFORM_PERMISSIONS.SETTINGS_UPDATE);
  const canPublish = permissions.includes(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH);
  const canWrite = canUpdate && canPublish;
  const [dirtyDraftBlocked, setDirtyDraftBlocked] = useState(false);

  const { data, error, isLoading, mutate } = useSWR(
    SWR_KEY,
    () => adminSettingsService.getDraft(),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const published = data?.publishedPolicies ?? {};

  const defaultAgent = useMemo(() => buildDefaultAgentFromPolicies(published), [published]);
  const systemAgent = useMemo(() => buildSystemAgentFromPolicies(published), [published]);
  const memory = useMemo(() => buildMemoryFromPolicies(published), [published]);
  const tts = useMemo(() => buildTtsFromPolicies(published), [published]);
  const image = useMemo(() => buildImageFromPolicies(published), [published]);

  const clearDirtyDraftBlocked = useCallback(() => setDirtyDraftBlocked(false), []);

  const applyPatch = useCallback(
    async (patch: Record<string, unknown>, reason?: string) => {
      if (!canWrite) {
        throw new Error('PLATFORM_PERMISSION_DENIED');
      }
      try {
        const result = await adminSettingsService.applyImmediate({ patch, reason });
        setDirtyDraftBlocked(false);
        await mutate();
        return result;
      } catch (err) {
        if (isUnpublishedSettingsDraftError(err)) {
          setDirtyDraftBlocked(true);
          // Re-throw so callers that care can still react; pages also read dirtyDraftBlocked.
          throw err;
        }
        throw err;
      }
    },
    [canWrite, mutate],
  );

  const updateDefaultAgentModel = useCallback(
    async (value: { model: string; provider: string }) => {
      await applyPatch({
        'defaultAgent.config.model': value.model,
        'defaultAgent.config.provider': value.provider,
      });
    },
    [applyPatch],
  );

  const updateSystemAgent = useCallback(
    async (
      key: Parameters<typeof systemAgentPatch>[0],
      value: Parameters<typeof systemAgentPatch>[1],
    ) => {
      const patch = systemAgentPatch(key, value);
      if (Object.keys(patch).length === 0) return;
      await applyPatch(patch);
    },
    [applyPatch],
  );

  const updateMemory = useCallback(
    async (patch: { enabled?: boolean; effort?: string }) => {
      const paths: Record<string, unknown> = {};
      if (patch.enabled !== undefined) paths['memory.enabled'] = patch.enabled;
      if (patch.effort !== undefined) paths['memory.effort'] = patch.effort;
      if (Object.keys(paths).length === 0) return;
      await applyPatch(paths);
    },
    [applyPatch],
  );

  const updateTts = useCallback(
    async (patch: { openAI?: { ttsModel?: string } }) => {
      if (patch.openAI?.ttsModel === undefined) return;
      await applyPatch({ 'tts.openAI.ttsModel': patch.openAI.ttsModel });
    },
    [applyPatch],
  );

  const updateImage = useCallback(
    async (patch: { defaultImageNum?: number }) => {
      if (patch.defaultImageNum === undefined) return;
      await applyPatch({ 'image.defaultImageNum': patch.defaultImageNum });
    },
    [applyPatch],
  );

  const mappedError = error ? mapEnterpriseError(error) : null;

  return {
    applyPatch,
    canWrite,
    clearDirtyDraftBlocked,
    defaultAgent,
    dirtyDraftBlocked,
    error: error instanceof Error ? error : error ? new Error(String(error)) : null,
    image,
    isInit: Boolean(data) && !isLoading,
    isLoading,
    mappedError,
    memory,
    mutate,
    systemAgent,
    tts,
    updateDefaultAgentModel,
    updateImage,
    updateMemory,
    updateSystemAgent,
    updateTts,
  };
};
