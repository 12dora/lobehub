/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserPanel from './index';
import PanelContent from './PanelContent';

interface PopoverMockProps {
  content: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  placement?: string;
}

const captured = vi.hoisted(() => ({ props: null as PopoverMockProps | null }));

vi.mock('@lobehub/ui', () => ({
  Popover: (props: PopoverMockProps & { children?: ReactNode }) => {
    captured.props = props;

    return (
      <div>
        <button type={'button'} onClick={() => props.onOpenChange?.(!props.open)}>
          open panel
        </button>
        {props.open ? <div data-testid={'popover-content'}>{props.content}</div> : null}
      </div>
    );
  },
}));

vi.mock('./UpgradeBadge', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('./useNewVersion', () => ({ useNewVersion: () => false }));

vi.mock('./PanelContent', () => ({
  default: ({ closePopover }: { closePopover: () => void }) => (
    <button data-testid={'panel-content'} type={'button'} onClick={closePopover}>
      panel content
    </button>
  ),
}));

describe('UserPanel', () => {
  beforeEach(() => {
    captured.props = null;
  });

  it('opens downward from the header chip instead of flipping from topLeft', () => {
    render(
      <UserPanel>
        <span>trigger</span>
      </UserPanel>,
    );

    expect(captured.props?.placement).toBe('bottomLeft');
    expect(captured.props?.placement).not.toBe('topLeft');
  });

  it('renders the panel content directly, with no skeleton boundary in between', () => {
    render(
      <UserPanel>
        <span>trigger</span>
      </UserPanel>,
    );

    fireEvent.click(screen.getByText('open panel'));

    expect(screen.getByTestId('panel-content')).toBeInTheDocument();
    // No intermediate <Suspense fallback={<PanelContentSkeleton />}> wrapper:
    // the content element is PanelContent itself, so opening cannot flash a skeleton.
    expect((captured.props?.content as { type?: unknown })?.type).toBe(PanelContent);
  });

  it('keeps the content element stable across open/close so the popup is not rebuilt', () => {
    render(
      <UserPanel>
        <span>trigger</span>
      </UserPanel>,
    );

    const initialContent = captured.props?.content;

    fireEvent.click(screen.getByText('open panel'));
    expect(captured.props?.content).toBe(initialContent);

    fireEvent.click(screen.getByText('open panel'));
    expect(captured.props?.content).toBe(initialContent);
  });

  it('closes the popover from the panel content', () => {
    render(
      <UserPanel>
        <span>trigger</span>
      </UserPanel>,
    );

    fireEvent.click(screen.getByText('open panel'));
    expect(screen.getByTestId('popover-content')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('panel-content'));
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument();
  });
});
