'use client';

import { mutate } from '@/libs/swr';

import {
  ADMIN_SYSTEM_DOCUMENT_RENDER_SETTINGS_KEY,
  ADMIN_SYSTEM_DOCUMENT_RENDER_STATUS_KEY,
  ADMIN_SYSTEM_INFRA_SETTINGS_KEY,
  ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY,
} from '../swrKeys';

/**
 * Refresh the 基础设施 snapshot after a write.
 *
 * Matched by predicate rather than by key literal because `useClientDataSWR` appends the active
 * workspace id to the key — an exact-key mutate would silently no-op.
 */
export const invalidateAdminInfraSettings = (): Promise<unknown> =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_SYSTEM_INFRA_SETTINGS_KEY);

export const invalidateAdminSandboxSettings = (): Promise<unknown> =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_SYSTEM_SANDBOX_SETTINGS_KEY);

export const invalidateAdminDocumentRenderSettings = (): Promise<unknown> =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_SYSTEM_DOCUMENT_RENDER_SETTINGS_KEY);

/**
 * The queue answer is derived from the settings, so a save has to drop it too — otherwise a card
 * that just switched sidecars keeps reporting the old one's health for up to a poll interval.
 */
export const invalidateAdminDocumentRenderStatus = (): Promise<unknown> =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_SYSTEM_DOCUMENT_RENDER_STATUS_KEY);
