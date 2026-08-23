'use client';

import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import type { NavigateFunction } from 'react-router';

import { isNotFoundError } from './isNotFoundError';
import {
  UserDetailError,
  UserDetailLoading,
  UserDetailNotFound,
  UserPanelError,
  UserPanelLoading,
  UserPanelNotFound,
} from './UserDetailStates';

interface UserDetailChromeParams {
  /** Slide-in panel gets the compact states; the page gets the full-chrome ones. */
  isPanel: boolean;
  navigate: NavigateFunction;
  onDismiss?: () => void;
  t: TFunction<'admin'>;
}

/** The target user is gone: dismiss from the panel, back to the list from the page. */
export const renderUserDetailNotFound = ({
  isPanel,
  navigate,
  onDismiss,
  t,
}: UserDetailChromeParams): ReactNode =>
  isPanel ? (
    <UserPanelNotFound t={t} onDismiss={onDismiss} />
  ) : (
    <UserDetailNotFound navigate={navigate} t={t} />
  );

interface UserDetailStateFallbackParams extends UserDetailChromeParams {
  data: unknown;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
  reduceMotion: boolean | null;
}

/**
 * State ordering (UI-R1-03) for the settled-data states, in order:
 * 1) loading, 2) structured not-found, 3) generic network/server error + retry.
 *
 * Returns null when none applies — the caller then handles the no-data fallback itself,
 * because that branch is what narrows `data` for the rest of the render.
 */
export const renderUserDetailStateFallback = ({
  data,
  error,
  isLoading,
  isPanel,
  navigate,
  onDismiss,
  onRetry,
  reduceMotion,
  t,
}: UserDetailStateFallbackParams): ReactNode | null => {
  // 1) Loading (no settled data)
  if (isLoading && !data && !error) {
    return isPanel ? (
      <UserPanelLoading reduceMotion={reduceMotion} t={t} />
    ) : (
      <UserDetailLoading reduceMotion={reduceMotion} t={t} />
    );
  }

  // 2) Structured not-found only
  if (isNotFoundError(error)) {
    return renderUserDetailNotFound({ isPanel, navigate, onDismiss, t });
  }

  // 3) Generic network/server error + retry (must be reachable)
  if (error && !data) {
    return isPanel ? (
      <UserPanelError t={t} onRetry={onRetry} />
    ) : (
      <UserDetailError t={t} onRetry={onRetry} />
    );
  }

  return null;
};
