import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { managedConnectorClient } from './enterpriseAdapter';
import { useConnectorAuthorizationActions } from './useConnectorAuthorizationActions';

const ATTEMPT_ID = '0123456789abcdef0123456789abcdef';

const createPopup = () => {
  const popup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    location: { assign: vi.fn() },
  };

  return popup;
};

const pendingForever = () => new Promise<never>(() => undefined);

describe('useConnectorAuthorizationActions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes authorization globally across connectors', async () => {
    const popup = createPopup();
    let resolveStart!: (value: {
      attemptId: string;
      authorizationUrl: string;
      bindingId: string;
    }) => void;
    const startPromise = new Promise<{
      attemptId: string;
      authorizationUrl: string;
      bindingId: string;
    }>((resolve) => {
      resolveStart = resolve;
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const startAuthorization = vi
      .spyOn(managedConnectorClient, 'startAuthorization')
      .mockReturnValue(startPromise);
    const getAuthorizationStatus = vi
      .spyOn(managedConnectorClient, 'getAuthorizationStatus')
      .mockImplementation(pendingForever);
    const { result } = renderHook(() => useConnectorAuthorizationActions());
    let firstAuthorization!: Promise<void>;

    act(() => {
      firstAuthorization = result.current.authorize(
        'connector-a',
        '/workspace-a/settings/connector',
      );
      void result.current.authorize('connector-b', '/workspace-b/settings/connector');
    });

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('about:blank', '_blank', 'width=600,height=720');
    expect(startAuthorization).toHaveBeenCalledOnce();
    expect(startAuthorization).toHaveBeenCalledWith({
      connectorId: 'connector-a',
      returnTo: '/workspace-a/settings/connector',
    });

    resolveStart({
      attemptId: ATTEMPT_ID,
      authorizationUrl: 'https://auth.example.com/authorize',
      bindingId: 'binding-a',
    });
    await waitFor(() => expect(getAuthorizationStatus).toHaveBeenCalledOnce());
    expect(getAuthorizationStatus).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      connectorId: 'connector-a',
    });
    expect(popup.location.assign).toHaveBeenCalledWith('https://auth.example.com/authorize');

    act(() => result.current.cancelAuthorization());
    await act(async () => firstAuthorization);
  });

  it('cancels polling, closes the popup, and reports user cancellation', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.spyOn(managedConnectorClient, 'startAuthorization').mockResolvedValue({
      attemptId: ATTEMPT_ID,
      authorizationUrl: 'https://auth.example.com/authorize',
      bindingId: 'binding-a',
    });
    const getAuthorizationStatus = vi
      .spyOn(managedConnectorClient, 'getAuthorizationStatus')
      .mockImplementation(pendingForever);
    const { result } = renderHook(() => useConnectorAuthorizationActions());
    let authorization!: Promise<void>;

    act(() => {
      authorization = result.current.authorize('connector-a');
    });
    await waitFor(() => expect(getAuthorizationStatus).toHaveBeenCalledOnce());

    act(() => result.current.cancelAuthorization());
    await act(async () => authorization);

    expect(popup.close).toHaveBeenCalledOnce();
    expect(getAuthorizationStatus).toHaveBeenCalledOnce();
    expect(result.current.feedback).toEqual({
      code: 'PLATFORM_CONNECTOR_OAUTH_CANCELLED',
      connectorId: 'connector-a',
      type: 'warning',
    });
    expect(result.current.busyConnectorId).toBeNull();
  });

  it('aborts polling and closes the popup on unmount', async () => {
    const popup = createPopup();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.spyOn(managedConnectorClient, 'startAuthorization').mockResolvedValue({
      attemptId: ATTEMPT_ID,
      authorizationUrl: 'https://auth.example.com/authorize',
      bindingId: 'binding-a',
    });
    const getAuthorizationStatus = vi
      .spyOn(managedConnectorClient, 'getAuthorizationStatus')
      .mockImplementation(pendingForever);
    const { result, unmount } = renderHook(() => useConnectorAuthorizationActions());
    let authorization!: Promise<void>;

    act(() => {
      authorization = result.current.authorize('connector-a');
    });
    await waitFor(() => expect(getAuthorizationStatus).toHaveBeenCalledOnce());

    unmount();
    await authorization;

    expect(popup.close).toHaveBeenCalledOnce();
    expect(getAuthorizationStatus).toHaveBeenCalledOnce();
  });
});
