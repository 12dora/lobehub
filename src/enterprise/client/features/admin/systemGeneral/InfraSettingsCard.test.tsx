// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { Box } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InfraSettingsCard } from './InfraSettingsCard';

const uiMocks = vi.hoisted(() => ({ confirmModal: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

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
  confirmModal: (props: unknown) => uiMocks.confirmModal(props),
  Modal: ({
    children,
    footer,
    onCancel,
    open,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    onCancel?: () => void;
    open?: boolean;
    title?: ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <h3>{title}</h3>
        {children}
        {footer}
        <button type="button" onClick={onCancel}>
          {`dismiss:${String(title)}`}
        </button>
      </div>
    ) : null,
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const FIELDS = [
  { label: 'one', value: '1' },
  { label: 'two', value: '2' },
  { label: 'three', value: '3' },
  { label: 'four', value: '4' },
  { label: 'five', value: '5' },
  { label: 'six', value: '6' },
];

describe('InfraSettingsCard', () => {
  it('shows five summary rows at most, and keeps the rest for 详情', () => {
    render(
      <InfraSettingsCard
        canTest
        envVars={['S3_BUCKET']}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onTest={vi.fn()}
      />,
    );

    // The sixth row would make this card taller than its neighbours in the grid.
    expect(screen.getByText('five')).toBeTruthy();
    expect(screen.queryByText('six')).toBeNull();
    // Environment variables are reference material, not a reading — they live in 详情.
    expect(screen.queryByText('S3_BUCKET')).toBeNull();
  });

  it('opens 详情 with the complete field list, the extra blocks and the env vars', () => {
    render(
      <InfraSettingsCard
        canTest
        details={<div>status-panel</div>}
        envVars={['S3_BUCKET']}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('status-panel')).toBeNull();

    fireEvent.click(screen.getByText('systemGeneral.card.details'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('six')).toBeTruthy();
    expect(screen.getByText('status-panel')).toBeTruthy();
    expect(screen.getByText('S3_BUCKET')).toBeTruthy();
  });

  it('offers 详情 only when the card has no editor', () => {
    render(
      <InfraSettingsCard
        canTest={false}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Sandbox"
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('systemGeneral.card.details')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.card.edit')).toBeNull();
  });

  it('says its one sentence in the body, with no door onto an empty room', () => {
    render(
      <InfraSettingsCard
        canTest={false}
        icon={Box}
        notice="the module is off"
        probing={false}
        title="Sandbox"
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('the module is off')).toBeTruthy();
    expect(screen.queryByText('systemGeneral.card.details')).toBeNull();
  });

  it('asks the card wrapper to open 编辑, and renders the form and its actions there', () => {
    const onEditOpenChange = vi.fn();
    const { rerender } = render(
      <InfraSettingsCard
        canTest
        editActions={<button type="button">save</button>}
        editor={<div>the-form</div>}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onEditOpenChange={onEditOpenChange}
        onTest={vi.fn()}
      />,
    );

    expect(screen.queryByText('the-form')).toBeNull();
    fireEvent.click(screen.getByText('systemGeneral.card.edit'));
    expect(onEditOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <InfraSettingsCard
        canTest
        editOpen
        editActions={<button type="button">save</button>}
        editor={<div>the-form</div>}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onEditOpenChange={onEditOpenChange}
        onTest={vi.fn()}
      />,
    );

    expect(screen.getByText('the-form')).toBeTruthy();
    expect(screen.getByText('save')).toBeTruthy();
  });

  it('closes a clean 编辑 modal without asking', () => {
    const onEditOpenChange = vi.fn();
    render(
      <InfraSettingsCard
        canTest
        editOpen
        editor={<div>the-form</div>}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onEditOpenChange={onEditOpenChange}
        onTest={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByText('dismiss:systemGeneral.card.editTitle:{"name":"Object storage"}'),
    );

    expect(uiMocks.confirmModal).not.toHaveBeenCalled();
    expect(onEditOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirms before throwing an unsaved draft away', () => {
    const onEditOpenChange = vi.fn();
    uiMocks.confirmModal.mockClear();
    render(
      <InfraSettingsCard
        canTest
        editDirty
        editOpen
        editor={<div>the-form</div>}
        fields={FIELDS}
        icon={Box}
        probing={false}
        title="Object storage"
        onEditOpenChange={onEditOpenChange}
        onTest={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByText('dismiss:systemGeneral.card.editTitle:{"name":"Object storage"}'),
    );

    expect(onEditOpenChange).not.toHaveBeenCalled();
    const config = uiMocks.confirmModal.mock.calls[0]![0] as {
      okText: string;
      onOk: () => void;
      title: string;
    };
    expect(config.title).toBe('systemGeneral.unsaved.title');
    config.onOk();
    expect(onEditOpenChange).toHaveBeenCalledWith(false);
  });
});
