'use client';

import { useCallback, useState } from 'react';

import { platformConnectorsService } from '@/enterprise/client/services/platformConnectors';

import type { ConnectorClientErrorCode } from './errorCode';
import { resolveConnectorErrorCode } from './errorCode';
import { waitForManagedConnectorAuthorization } from './oauthFlow';
import { refreshManagedConnectorLists } from './useManagedConnectors';

export interface ConnectorActionFeedback {
  code: ConnectorClientErrorCode;
  connectorId: string;
  type: 'error' | 'success' | 'warning';
}

export const useConnectorAuthorizationActions = () => {
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ConnectorActionFeedback | null>(null);

  const authorize = useCallback(async (connectorId: string) => {
    const popup = window.open('about:blank', 'platform-connector-oauth', 'width=600,height=720');
    if (!popup) {
      setFeedback({
        code: 'PLATFORM_CONNECTOR_OAUTH_POPUP_BLOCKED',
        connectorId,
        type: 'error',
      });
      return;
    }

    setBusyConnectorId(connectorId);
    setFeedback(null);
    try {
      const { authorizationUrl } = await platformConnectorsService.startAuthorization({
        connectorId,
        returnTo: '/settings/connector',
      });
      popup.location.assign(authorizationUrl);
      const result = await waitForManagedConnectorAuthorization({
        getStatus: async () =>
          (await platformConnectorsService.getAuthorizationStatus({ connectorId })).binding,
        popup,
      });
      if (!popup.closed) popup.close();
      await refreshManagedConnectorLists();

      setFeedback(
        result.status === 'connected'
          ? { code: 'PLATFORM_CONNECTOR_OPERATION_SUCCEEDED', connectorId, type: 'success' }
          : result.status === 'dismissed'
            ? { code: 'PLATFORM_CONNECTOR_OAUTH_DISMISSED', connectorId, type: 'warning' }
            : result.status === 'timeout'
              ? { code: 'PLATFORM_CONNECTOR_OAUTH_TIMEOUT', connectorId, type: 'error' }
              : { code: 'PLATFORM_CONNECTOR_OPERATION_FAILED', connectorId, type: 'error' },
      );
    } catch (error) {
      if (!popup.closed) popup.close();
      setFeedback({ code: resolveConnectorErrorCode(error), connectorId, type: 'error' });
    } finally {
      setBusyConnectorId(null);
    }
  }, []);

  const disconnect = useCallback(async (connectorId: string) => {
    setBusyConnectorId(connectorId);
    setFeedback(null);
    try {
      await platformConnectorsService.disconnect({ connectorId });
      await refreshManagedConnectorLists();
      setFeedback({ code: 'PLATFORM_CONNECTOR_DISCONNECTED', connectorId, type: 'success' });
    } catch (error) {
      setFeedback({ code: resolveConnectorErrorCode(error), connectorId, type: 'error' });
    } finally {
      setBusyConnectorId(null);
    }
  }, []);

  return { authorize, busyConnectorId, disconnect, feedback };
};
