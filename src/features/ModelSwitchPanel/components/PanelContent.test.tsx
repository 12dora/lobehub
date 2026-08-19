/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PanelContent } from './PanelContent';

const mocks = vi.hoisted(() => ({
  groupMode: 'byProvider' as 'byModel' | 'byProvider',
  handleGroupModeChange: vi.fn(),
  isDevMode: false,
}));

vi.mock('./List', () => ({
  List: ({ groupMode }: { groupMode?: string }) => (
    <div data-group-mode={groupMode} data-testid="list" />
  ),
}));

vi.mock('./Toolbar', () => ({
  Toolbar: ({
    groupMode,
    showGroupModeSwitch,
  }: {
    groupMode?: string;
    showGroupModeSwitch?: boolean;
  }) => (
    <div
      data-group-mode={groupMode}
      data-show-group-mode-switch={String(Boolean(showGroupModeSwitch))}
      data-testid="toolbar"
    />
  ),
}));

vi.mock('@/hooks/useEnabledChatModels', () => ({
  useEnabledChatModels: () => [],
}));

vi.mock('@/business/client/hooks/useBusinessModelPricing', () => ({
  useBusinessModelPricingPrefetch: vi.fn(),
}));

vi.mock('../hooks/usePanelSize', () => ({
  usePanelSize: () => ({
    handlePanelWidthChange: vi.fn(),
    panelHeight: 460,
    panelWidth: 320,
  }),
}));

vi.mock('../hooks/usePanelState', () => ({
  usePanelState: () => ({
    groupMode: mocks.groupMode,
    handleGroupModeChange: mocks.handleGroupModeChange,
  }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/user/slices/settings/selectors/general', () => ({
  userGeneralSettingsSelectors: {
    config: () => ({ isDevMode: mocks.isDevMode }),
  },
}));

describe('PanelContent group mode', () => {
  beforeEach(() => {
    mocks.groupMode = 'byProvider';
    mocks.isDevMode = false;
  });

  it('passes the persisted byProvider mode through in a non-dev build', () => {
    render(<PanelContent />);

    expect(screen.getByTestId('list')).toHaveAttribute('data-group-mode', 'byProvider');
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-group-mode', 'byProvider');
  });

  it('passes the persisted byModel mode through in a non-dev build', () => {
    mocks.groupMode = 'byModel';

    render(<PanelContent />);

    expect(screen.getByTestId('list')).toHaveAttribute('data-group-mode', 'byModel');
    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-group-mode', 'byModel');
  });

  it('shows the group-mode switch outside dev mode', () => {
    render(<PanelContent />);

    expect(screen.getByTestId('toolbar')).toHaveAttribute('data-show-group-mode-switch', 'true');
  });
});
