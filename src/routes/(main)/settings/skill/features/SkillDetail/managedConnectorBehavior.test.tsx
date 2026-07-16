/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  ManagedComposioDisconnectButton,
  shouldSyncConnectorDefinition,
} from './managedConnectorBehavior';

const confirmModal = vi.hoisted(() => vi.fn());

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('managed Connector behavior', () => {
  it('blocks every automatic definition sync while managed', () => {
    expect(shouldSyncConnectorDefinition({ isConnectorType: true, managed: true })).toBe(false);
    expect(shouldSyncConnectorDefinition({ isConnectorType: true, managed: false })).toBe(true);
  });

  it('confirms and disconnects an active Composio owner connection by identifier', async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn().mockResolvedValue(undefined);
    const onDisconnected = vi.fn();
    confirmModal.mockImplementation(({ onOk }: { onOk: () => Promise<void> }) => void onOk());

    render(
      <ManagedComposioDisconnectButton
        canEdit
        identifier="gmail"
        label="Gmail"
        onDisconnect={onDisconnect}
        onDisconnected={onDisconnected}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(onDisconnect).toHaveBeenCalledWith('gmail');
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });
});
