import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NAV_SECTION_TRAVEL_PX, SECTION_TRANSITION_S } from '@/features/RouteTransition/timing';

import { NavPanelDraggable } from './NavPanelDraggable';

const state = vi.hoisted(() => ({
  reduceMotion: false as boolean | null,
}));

interface MotionDivProps {
  [key: string]: unknown;
  animate?: unknown;
  children?: ReactNode;
  exit?: unknown;
  initial?: unknown;
  transition?: unknown;
}

vi.mock('motion/react', () => ({
  m: {
    div: ({ animate, children, exit, initial, transition, ...rest }: MotionDivProps) => (
      <div
        {...(rest as Record<string, unknown>)}
        data-animate={JSON.stringify(animate ?? null)}
        data-exit={JSON.stringify(exit ?? null)}
        data-initial={JSON.stringify(initial ?? null)}
        data-section-layer="true"
        data-transition={JSON.stringify(transition ?? null)}
      >
        {children}
      </div>
    ),
  },
  useReducedMotion: () => state.reduceMotion,
}));

vi.mock('@lobehub/ui', () => ({
  DraggablePanel: ({ children }: { children?: ReactNode }) => (
    <div data-testid="draggable-panel">{children}</div>
  ),
}));

vi.mock('@/business/client/features/NavPanelUpgradeEntry', () => ({ default: () => null }));
vi.mock('@/routes/(main)/home/_layout/Footer', () => ({ default: () => null }));
vi.mock('@/routes/(main)/home/_layout/Header/components/User', () => ({
  USER_DROPDOWN_ICON_ID: 'user-dropdown-icon',
}));
vi.mock('@/features/NavPanel/ToggleLeftPanelButton', () => ({
  TOGGLE_BUTTON_ID: 'toggle-button',
}));
vi.mock('./BackButton', () => ({ BACK_BUTTON_ID: 'back-button' }));
vi.mock('../hooks/useNavPanel', () => ({
  useNavPanelSizeChangeHandler: () => vi.fn(),
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: Object.assign((selector: (s: unknown) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));

vi.mock('@/store/global/selectors', () => ({
  NAV_PANEL_MAX_WIDTH: 400,
  NAV_PANEL_MIN_WIDTH: 240,
  systemStatusSelectors: {
    isStatusInit: () => true,
    leftPanelWidth: () => 280,
    showLeftPanel: () => true,
  },
}));

const section = (key: string) => ({ key, node: <div>{key} sidebar</div> });

const layer = (container: HTMLElement) =>
  container.querySelector('[data-section-layer]') as HTMLElement | null;

const readProp = (container: HTMLElement, attribute: string): unknown =>
  JSON.parse(layer(container)?.getAttribute(attribute) ?? 'null');

describe('NavPanelDraggable', () => {
  beforeEach(() => {
    state.reduceMotion = false;
  });

  afterEach(() => {
    document.documentElement.dir = '';
  });

  it('does not animate the first section (it is part of the first paint)', () => {
    const { container } = render(<NavPanelDraggable activeContent={section('home')} />);

    expect(layer(container)).not.toBeNull();
    expect(readProp(container, 'data-initial')).toBe(false);
  });

  it('slides the incoming section in from the inline-end when going deeper', () => {
    const { container, rerender } = render(<NavPanelDraggable activeContent={section('home')} />);

    rerender(<NavPanelDraggable activeContent={section('settings')} />);

    expect(readProp(container, 'data-initial')).toEqual({
      opacity: 0,
      x: NAV_SECTION_TRAVEL_PX,
    });
    expect(readProp(container, 'data-animate')).toEqual({ opacity: 1, x: 0 });
  });

  it('slides in from the inline-start when going back up', () => {
    const { container, rerender } = render(
      <NavPanelDraggable activeContent={section('settings')} />,
    );

    rerender(<NavPanelDraggable activeContent={section('home')} />);

    expect(readProp(container, 'data-initial')).toEqual({
      opacity: 0,
      x: -NAV_SECTION_TRAVEL_PX,
    });
  });

  it('mirrors the travel under rtl', () => {
    document.documentElement.dir = 'rtl';
    const { container, rerender } = render(<NavPanelDraggable activeContent={section('home')} />);

    rerender(<NavPanelDraggable activeContent={section('settings')} />);

    expect(readProp(container, 'data-initial')).toEqual({
      opacity: 0,
      x: -NAV_SECTION_TRAVEL_PX,
    });
  });

  it('folds nav keys and route keys onto one section, so aliases do not slide', () => {
    const { container, rerender } = render(
      <NavPanelDraggable activeContent={section('community')} />,
    );

    // Community's portal registers `discover` after the route fallback rendered
    // `community` — same place, so there is no direction to show.
    rerender(<NavPanelDraggable activeContent={section('discover')} />);

    expect(readProp(container, 'data-initial')).toEqual({ opacity: 0, x: 0 });
  });

  it('runs on the shared section clock', () => {
    const { container, rerender } = render(<NavPanelDraggable activeContent={section('home')} />);

    rerender(<NavPanelDraggable activeContent={section('image')} />);

    expect(readProp(container, 'data-transition')).toEqual({
      duration: SECTION_TRANSITION_S,
      ease: [0.32, 0.72, 0, 1],
    });
  });

  it('drops the motion entirely under reduced motion', () => {
    state.reduceMotion = true;
    const { container, rerender } = render(<NavPanelDraggable activeContent={section('home')} />);

    rerender(<NavPanelDraggable activeContent={section('settings')} />);

    expect(readProp(container, 'data-initial')).toBe(false);
    expect(readProp(container, 'data-transition')).toEqual({
      duration: 0,
      ease: [0.32, 0.72, 0, 1],
    });
  });

  it('never renders an exit animation (two live sidebars would duplicate DOM ids)', () => {
    const { container, rerender } = render(<NavPanelDraggable activeContent={section('home')} />);

    rerender(<NavPanelDraggable activeContent={section('settings')} />);

    expect(readProp(container, 'data-exit')).toBeNull();
    expect(container.querySelectorAll('[data-section-layer]')).toHaveLength(1);
  });
});
