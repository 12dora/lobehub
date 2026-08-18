/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ZodModule from 'zod';

import { ConnectorSourceType, ConnectorToolPermission } from '@/database/schemas';

import ConnectorDetail from './index';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

const mocks = vi.hoisted(() => ({
  toolState: {
    connectorTools: {
      createTools: [] as Array<{ id: string }>,
      deleteTools: [] as Array<{ id: string }>,
      readTools: [] as Array<{ id: string }>,
      updateTools: [] as Array<{ id: string }>,
    },
    connectors: [] as Array<{
      id: string;
      identifier: string;
      metadata?: { description?: string };
      mcpConnectionType?: string;
      name: string;
      sourceType: string;
    }>,
    deleteConnector: vi.fn(),
    disconnectConnector: vi.fn(),
    fetchConnectors: vi.fn(),
    resetConnectorPermissions: vi.fn(),
    syncBuiltinTool: vi.fn(),
    syncConnectorTools: vi.fn(),
    syncPluginTools: vi.fn(),
    syncing: false,
    uninstallBuiltinTool: vi.fn(),
    uninstallMCPPlugin: vi.fn(),
    updateToolPermission: vi.fn(),
    updateToolsPermission: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string } | string) =>
      typeof options === 'object' ? (options.defaultValue ?? _key) : (options ?? _key),
  }),
}));

vi.mock('@lobechat/const', () => ({
  getComposioAppByIdentifier: () => undefined,
  getLobehubSkillProviderById: () => undefined,
}));

// Stub the base-ui Button to a native button — it needs a MotionProvider the
// app sets up globally but the unit env doesn't.
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
}));

vi.mock('@/store/tool', () => ({
  useToolStore<T>(selector: (state: typeof mocks.toolState) => T): T {
    return selector(mocks.toolState);
  },
}));

vi.mock('@/store/tool/slices/connector', () => ({
  connectorSelectors: {
    connectorById:
      (connectorId: string) =>
      (state: typeof mocks.toolState): (typeof mocks.toolState.connectors)[number] | undefined =>
        state.connectors.find((connector) => connector.id === connectorId),
    connectorToolsGrouped: () => (state: typeof mocks.toolState) => state.connectorTools,
    isSyncing: () => (state: typeof mocks.toolState) => state.syncing,
  },
}));

vi.mock('../CustomConnectorModal', () => ({
  default: () => <div data-testid="custom-connector-modal" />,
}));

vi.mock('./ToolPermissionGroup', () => ({
  default: ({
    label,
    onBatchPermission,
    onPermissionChange,
    tools,
  }: {
    label: string;
    onBatchPermission: (ids: string[], permission: string) => void;
    onPermissionChange: (id: string, permission: string) => void;
    tools: Array<{ id: string }>;
  }) => (
    <div data-testid="permission-group">
      {label}
      {tools.length > 0 && (
        <button
          type="button"
          onClick={() =>
            onBatchPermission(
              tools.map((tool) => tool.id),
              ConnectorToolPermission.disabled,
            )
          }
        >
          disable all {label}
        </button>
      )}
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => onPermissionChange(tool.id, ConnectorToolPermission.auto)}
        >
          allow {tool.id}
        </button>
      ))}
    </div>
  ),
}));

describe('ConnectorDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toolState.connectorTools = {
      createTools: [],
      deleteTools: [],
      readTools: [],
      updateTools: [],
    };
    mocks.toolState.connectors = [
      {
        id: 'connector-1',
        identifier: 'notion',
        metadata: { description: 'Workspace notes' },
        name: 'Notion',
        sourceType: ConnectorSourceType.marketplace,
      },
    ];
    mocks.toolState.syncing = false;
  });

  it('uses lifecycle actions instead of the generic marketplace uninstall action', () => {
    render(
      <ConnectorDetail
        connectorId="connector-1"
        lifecycleActions={<button>Disconnect Notion</button>}
      />,
    );

    expect(screen.getByText('Notion')).toBeInTheDocument();
    expect(screen.getByText('Workspace notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect Notion' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connector.uninstall' })).not.toBeInTheDocument();
  });

  it('falls back to the marketplace uninstall action when no lifecycle override is provided', () => {
    render(<ConnectorDetail connectorId="connector-1" />);

    expect(screen.getByRole('button', { name: 'connector.uninstall' })).toBeInTheDocument();
  });

  it('keeps OAuth lifecycle and tool permissions editable in managed-safe detail', () => {
    mocks.toolState.connectorTools.readTools = [{ id: 'search-pages' }];

    render(
      <ConnectorDetail
        managed
        connectorId="connector-1"
        lifecycleActions={<button>Disconnect Notion</button>}
      />,
    );

    screen.getByRole('button', { name: 'connector.resetPermissions' }).click();
    screen.getByRole('button', { name: 'allow search-pages' }).click();

    expect(mocks.toolState.resetConnectorPermissions).toHaveBeenCalledWith('connector-1');
    expect(mocks.toolState.updateToolPermission).toHaveBeenCalledWith(
      'search-pages',
      ConnectorToolPermission.auto,
    );
    expect(screen.getByRole('button', { name: 'Disconnect Notion' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connector.refresh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'connector.uninstall' })).not.toBeInTheDocument();
  });

  it('routes a group action through the batched store write instead of one call per tool', () => {
    mocks.toolState.connectorTools.readTools = [{ id: 'search-pages' }, { id: 'read-page' }];

    render(<ConnectorDetail connectorId="connector-1" />);

    screen.getByRole('button', { name: 'disable all connector.readOnlyTools' }).click();

    expect(mocks.toolState.updateToolsPermission).toHaveBeenCalledTimes(1);
    expect(mocks.toolState.updateToolsPermission).toHaveBeenCalledWith(
      ['search-pages', 'read-page'],
      ConnectorToolPermission.disabled,
    );
    expect(mocks.toolState.updateToolPermission).not.toHaveBeenCalled();
  });
});
