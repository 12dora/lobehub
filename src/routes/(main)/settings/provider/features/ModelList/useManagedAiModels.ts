'use client';

import { use } from 'react';

import { useManagedResource } from '@/features/ManagedResources';

import { ProviderSettingsContext } from './ProviderSettingsContext';

/**
 * Whether the AI-model catalog is managed *for the surface currently rendering*.
 *
 * `managedResources.aiModels` is a GLOBAL capability with no per-principal exemption —
 * `buildPlatformCapabilities` serves one snapshot to everyone — and the admin platform
 * catalog renders these very components (`ProviderSettingsPage` mounts the shared
 * `ProviderDetailPageComponent`). Reading it raw therefore hid the catalog's own editing
 * controls from the administrator who enabled the policy: publishing 平台托管 for models
 * made "sync upstream models", "add model" and the whole overflow menu vanish from the
 * admin panel too.
 *
 * The policy freezes the MEMBERS' overlay on the published catalog; it is not a statement
 * about the catalog itself. So the admin catalog surface is exempt, and every member
 * surface keeps the previous behaviour.
 */
export const useManagedAiModels = (): boolean => {
  const { adminPlatformCatalog } = use(ProviderSettingsContext);
  const { managed } = useManagedResource('aiModels');

  return managed && !adminPlatformCatalog;
};
