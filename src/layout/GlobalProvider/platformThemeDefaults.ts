import { useSyncExternalStore } from 'react';

import { resolveSafePlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

/**
 * Platform theme defaults (admin → 品牌自定义 → 主色) for the app shell.
 *
 * `AppTheme` sits above the enterprise provider tree, so it cannot read the runtime
 * branding context directly. The value is therefore seeded synchronously from the
 * server-injected public snapshot — which keeps the first paint on the right colour —
 * and republished by `RuntimeBrandingProvider` whenever the snapshot changes (desktop
 * shells that have no injected config, and admins saving new branding).
 */

/** Colour tokens end up in CSS, so only a strict 6-digit hex is ever accepted. */
const HEX_PATTERN = /^#[\dA-F]{6}$/i;

const sanitize = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const next = value.trim();

  return HEX_PATTERN.test(next) ? next : null;
};

const readInjectedPrimaryColor = (): string | null => {
  if (typeof window === 'undefined') return null;
  const snapshot = resolveSafePlatformPublicSnapshot(
    window.__SERVER_CONFIG__?.platformPublicSnapshot,
  );

  return sanitize(snapshot.branding?.themeDefaults?.primaryColor);
};

let primaryColor: string | null = readInjectedPrimaryColor();
const listeners = new Set<() => void>();

export const getPlatformDefaultPrimaryColor = (): string | null => primaryColor;

/** Publishes the platform default primary colour. Unusable values clear it. */
export const setPlatformDefaultPrimaryColor = (value: string | null): void => {
  const next = sanitize(value);
  if (next === primaryColor) return;

  primaryColor = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const usePlatformDefaultPrimaryColor = (): string | null =>
  useSyncExternalStore(subscribe, getPlatformDefaultPrimaryColor, getPlatformDefaultPrimaryColor);
