'use client';

import { useCallback, useState } from 'react';

import type { SharedOAuthDeviceCode } from './useAdminSharedOAuthFlow';

interface SharedOAuthConnectRouteInput {
  connect: () => Promise<SharedOAuthDeviceCode | undefined>;
  deviceCode?: SharedOAuthDeviceCode;
  reset: () => void;
  submitApiKey: (apiKey: string) => Promise<void>;
  webSessionOnly: boolean;
}

/**
 * Which connect route the operator is on, and every way of entering or leaving one. The two
 * routes share one flow underneath, so the panel — not the flow — has to remember which of
 * them is running.
 */
export const useSharedOAuthConnectRoute = ({
  connect,
  deviceCode,
  reset,
  submitApiKey,
  webSessionOnly,
}: SharedOAuthConnectRouteInput) => {
  /**
   * Whether the flow was started from the "cannot renew itself" warning's primary fix, in
   * which case the paste panel must open ON the web-session box instead of making the
   * operator hunt for the section they just asked for.
   */
  const [openSessionSection, setOpenSessionSection] = useState(false);

  /**
   * The operator is connecting with an API key rather than a browser login. Held here, because
   * the two routes share one flow underneath: the key is redeemed against a device-code
   * envelope, so an envelope has to be requested first — silently, with no page to open and no
   * code to read. Without this flag the panel would flash the device-code chrome for the
   * length of that round trip, and land a failed exchange on a screen that has no field on it.
   */
  const [apiKeyRoute, setApiKeyRoute] = useState(false);

  const handleConnect = useCallback(async () => {
    // A web-session-only provider has exactly one box to land on, and this is it.
    setApiKeyRoute(false);
    setOpenSessionSection(webSessionOnly);
    const info = await connect();
    // The paste flow opens the authorization page from its own explicit step: the operator
    // has to come back with the callback URL, so the instructions must be read first.
    if (info?.flow === 'authorization_code_paste') return;
    // The click still counts as user activation here, so the popup normally opens;
    // the explicit button below stays as the fallback when it is blocked.
    const uri = info?.verificationUriComplete || info?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [connect, webSessionOnly]);

  /** Same flow, landing on the web-session box — the one-paste route to auto-renewal. */
  const handleConnectWithSession = useCallback(async () => {
    setApiKeyRoute(false);
    setOpenSessionSection(true);
    await connect();
  }, [connect]);

  /**
   * Connect with a dashboard API key. The envelope handling belongs to the flow — whether one
   * is still live is a reading only it can make — so this only records WHICH route is running.
   * No window is opened and no user code is surfaced: this route has neither.
   */
  const handleSubmitApiKey = useCallback(
    async (apiKey: string) => {
      setApiKeyRoute(true);
      await submitApiKey(apiKey);
    },
    [submitApiKey],
  );

  /** Cancel drops the API-key route with the flow it was driving. */
  const handleReset = useCallback(() => {
    setApiKeyRoute(false);
    reset();
  }, [reset]);

  const handleOpenVerification = useCallback(() => {
    const uri = deviceCode?.verificationUriComplete || deviceCode?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [deviceCode?.verificationUri, deviceCode?.verificationUriComplete]);

  return {
    apiKeyRoute,
    handleConnect,
    handleConnectWithSession,
    handleOpenVerification,
    handleReset,
    handleSubmitApiKey,
    openSessionSection,
  };
};
