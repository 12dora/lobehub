'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { managedConnectorClient } from './enterpriseAdapter';
import type { ConnectorClientErrorCode } from './errorCode';
import { resolveConnectorErrorCode } from './errorCode';
import { waitForManagedConnectorAuthorization } from './oauthFlow';
import { refreshManagedConnectorLists } from './useManagedConnectors';

export interface ConnectorActionFeedback {
  code: ConnectorClientErrorCode;
  connectorId: string;
  type: 'error' | 'success' | 'warning';
}

interface ConnectorAuthorizationAttempt {
  cancelledByUser: boolean;
  controller: AbortController;
  popup: Window;
}

export const useConnectorAuthorizationActions = () => {
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'authorize' | 'disconnect' | null>(null);
  const [feedback, setFeedback] = useState<ConnectorActionFeedback | null>(null);
  const attemptRef = useRef<ConnectorAuthorizationAttempt | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = attemptRef.current;
      attemptRef.current = null;
      attempt?.controller.abort();
      if (attempt && !attempt.popup.closed) attempt.popup.close();
    };
  }, []);

  const cancelAuthorization = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attempt.cancelledByUser = true;
    attempt.controller.abort();
    if (!attempt.popup.closed) attempt.popup.close();
  }, []);

  const authorize = useCallback(async (connectorId: string, returnTo = '/settings/connector') => {
    if (attemptRef.current) return;
    const popup = window.open('about:blank', '_blank', 'width=600,height=720');
    if (!popup) {
      setFeedback({
        code: 'PLATFORM_CONNECTOR_OAUTH_POPUP_BLOCKED',
        connectorId,
        type: 'error',
      });
      return;
    }

    const attempt: ConnectorAuthorizationAttempt = {
      cancelledByUser: false,
      controller: new AbortController(),
      popup,
    };
    attemptRef.current = attempt;

    setBusyConnectorId(connectorId);
    setBusyAction('authorize');
    setFeedback(null);
    try {
      const { attemptId, authorizationUrl } = await managedConnectorClient.startAuthorization({
        connectorId,
        returnTo,
      });
      if (attempt.controller.signal.aborted) {
        if (mountedRef.current && attempt.cancelledByUser) {
          setFeedback({
            code: 'PLATFORM_CONNECTOR_OAUTH_CANCELLED',
            connectorId,
            type: 'warning',
          });
        }
        return;
      }
      popup.location.assign(authorizationUrl);
      const result = await waitForManagedConnectorAuthorization({
        getStatus: () => managedConnectorClient.getAuthorizationStatus({ attemptId, connectorId }),
        popup,
        signal: attempt.controller.signal,
      });
      if (!popup.closed) popup.close();
      if (result.status === 'cancelled') {
        if (mountedRef.current && attempt.cancelledByUser) {
          setFeedback({
            code: 'PLATFORM_CONNECTOR_OAUTH_CANCELLED',
            connectorId,
            type: 'warning',
          });
        }
        return;
      }
      if (result.status === 'connected') await refreshManagedConnectorLists();

      if (mountedRef.current) {
        setFeedback(
          result.status === 'connected'
            ? { code: 'PLATFORM_CONNECTOR_OPERATION_SUCCEEDED', connectorId, type: 'success' }
            : result.status === 'dismissed'
              ? { code: 'PLATFORM_CONNECTOR_OAUTH_DISMISSED', connectorId, type: 'warning' }
              : result.status === 'timeout' || result.status === 'expired'
                ? { code: 'PLATFORM_CONNECTOR_OAUTH_TIMEOUT', connectorId, type: 'error' }
                : { code: 'PLATFORM_CONNECTOR_OPERATION_FAILED', connectorId, type: 'error' },
        );
      }
    } catch (error) {
      if (!popup.closed) popup.close();
      if (mountedRef.current && !attempt.controller.signal.aborted) {
        setFeedback({ code: resolveConnectorErrorCode(error), connectorId, type: 'error' });
      }
    } finally {
      if (attemptRef.current === attempt) attemptRef.current = null;
      if (mountedRef.current) {
        setBusyConnectorId(null);
        setBusyAction(null);
      }
    }
  }, []);

  const disconnect = useCallback(async (connectorId: string) => {
    if (attemptRef.current) return;
    setBusyConnectorId(connectorId);
    setBusyAction('disconnect');
    setFeedback(null);
    try {
      await managedConnectorClient.disconnect({ connectorId });
      await refreshManagedConnectorLists();
      if (mountedRef.current) {
        setFeedback({ code: 'PLATFORM_CONNECTOR_DISCONNECTED', connectorId, type: 'success' });
      }
    } catch (error) {
      if (mountedRef.current) {
        setFeedback({ code: resolveConnectorErrorCode(error), connectorId, type: 'error' });
      }
    } finally {
      if (mountedRef.current) {
        setBusyConnectorId(null);
        setBusyAction(null);
      }
    }
  }, []);

  return { authorize, busyAction, busyConnectorId, cancelAuthorization, disconnect, feedback };
};
