/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConnectorToolPermission } from '@/database/schemas';
import type { ConnectorTool } from '@/store/tool/slices/connector';

import ToolPermissionGroup from './ToolPermissionGroup';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// base-ui needs providers the unit env doesn't set up — stub to native elements.
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: (e: unknown) => void;
  }) => (
    <button data-testid="group-trigger" disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenu: ({
    children,
    disabled,
    items,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    items: { key: string; label: string; onClick: () => void }[];
  }) => (
    <div data-menu-disabled={disabled ? 'true' : 'false'}>
      {children}
      {items.map((item) => (
        <button
          disabled={disabled}
          key={item.key}
          type="button"
          onClick={() => {
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./ToolPermissionRow', () => ({
  default: ({ tool }: { tool: ConnectorTool }) => <div data-testid="row">{tool.toolName}</div>,
}));

const tool = (id: string, permission: ConnectorToolPermission): ConnectorTool => ({
  crudType: 'read',
  description: null,
  displayName: id,
  id,
  inputSchema: null,
  permission,
  toolName: id,
  userConnectorId: 'connector-1',
});

const renderGroup = (props: {
  onBatchPermission?: (toolIds: string[], permission: ConnectorToolPermission) => Promise<void>;
  readOnly?: boolean;
  tools: ConnectorTool[];
}) => {
  const onBatchPermission = props.onBatchPermission ?? vi.fn();
  const onPermissionChange = vi.fn();
  render(
    <ToolPermissionGroup
      label="Read-only tools"
      readOnly={props.readOnly}
      tools={props.tools}
      onBatchPermission={onBatchPermission}
      onPermissionChange={onPermissionChange}
    />,
  );
  return { onBatchPermission };
};

describe('ToolPermissionGroup', () => {
  it('labels the trigger from the children when every tool shares one permission', () => {
    renderGroup({
      tools: [tool('a', ConnectorToolPermission.auto), tool('b', ConnectorToolPermission.auto)],
    });

    expect(screen.getByTestId('group-trigger')).toHaveTextContent('connector.permission.autoAll');
  });

  it.each([
    [ConnectorToolPermission.needs_approval, 'connector.permission.approvalAll'],
    [ConnectorToolPermission.disabled, 'connector.permission.disableAll'],
  ])('labels a uniform %s group with its own key', (permission, expected) => {
    renderGroup({ tools: [tool('a', permission), tool('b', permission)] });

    expect(screen.getByTestId('group-trigger')).toHaveTextContent(expected);
  });

  it('falls back to custom when the children are mixed', () => {
    renderGroup({
      tools: [tool('a', ConnectorToolPermission.auto), tool('b', ConnectorToolPermission.disabled)],
    });

    expect(screen.getByTestId('group-trigger')).toHaveTextContent('connector.permission.custom');
  });

  it('applies a menu choice to every tool in ONE batch call', async () => {
    const onBatchPermission = vi.fn().mockResolvedValue(undefined);
    renderGroup({
      onBatchPermission,
      tools: [
        tool('a', ConnectorToolPermission.auto),
        tool('b', ConnectorToolPermission.disabled),
        tool('c', ConnectorToolPermission.needs_approval),
      ],
    });

    await userEvent.click(screen.getByRole('button', { name: 'connector.permission.autoAll' }));

    expect(onBatchPermission).toHaveBeenCalledTimes(1);
    expect(onBatchPermission).toHaveBeenCalledWith(['a', 'b', 'c'], ConnectorToolPermission.auto);
  });

  it('hides the batch dropdown in read-only mode', () => {
    renderGroup({
      readOnly: true,
      tools: [tool('a', ConnectorToolPermission.auto)],
    });

    expect(screen.queryByTestId('group-trigger')).not.toBeInTheDocument();
    expect(screen.getByTestId('row')).toBeInTheDocument();
  });

  it('disables the trigger while a batch write is in flight', async () => {
    let release: (() => void) | undefined;
    const onBatchPermission = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderGroup({ onBatchPermission, tools: [tool('a', ConnectorToolPermission.auto)] });

    await userEvent.click(screen.getByRole('button', { name: 'connector.permission.disableAll' }));

    expect(screen.getByTestId('group-trigger')).toBeDisabled();

    release?.();
    await vi.waitFor(() => expect(screen.getByTestId('group-trigger')).not.toBeDisabled());
    expect(onBatchPermission).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the group has no tools', () => {
    const { container } = render(
      <ToolPermissionGroup
        label="Read-only tools"
        tools={[]}
        onBatchPermission={vi.fn()}
        onPermissionChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
