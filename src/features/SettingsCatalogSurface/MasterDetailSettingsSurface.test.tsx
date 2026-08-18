import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MasterDetailSettingsSurface, {
  masterDetailSurfaceStyles as styles,
} from './MasterDetailSettingsSurface';

/**
 * Each column of the catalog chrome owns its own scrollport. A flex child whose
 * `min-height` stays `auto` grows with its content instead of scrolling, so the
 * whole surface overflows the settings pane and gets clipped.
 */
describe('MasterDetailSettingsSurface geometry', () => {
  const renderSurface = () =>
    render(
      <MasterDetailSettingsSurface
        detail={<div data-testid="detail-content" />}
        leftBody={<div data-testid="left-content" />}
        leftTitle="Skills"
      />,
    );

  it.each([
    ['root', () => styles.root],
    ['left', () => styles.left],
    ['leftBody', () => styles.leftBody],
    ['detail', () => styles.detail],
  ])('%s can shrink below its content', (_name, getClass) => {
    const { container } = renderSurface();

    const el = container.querySelector(`.${getClass()}`) as HTMLElement;
    expect(el).toBeTruthy();
    expect(getComputedStyle(el).minHeight).toBe('0');
  });

  it('keeps the scrolling columns on auto overflow', () => {
    const { container } = renderSurface();

    const leftBody = container.querySelector(`.${styles.leftBody}`) as HTMLElement;
    const detail = container.querySelector(`.${styles.detail}`) as HTMLElement;
    expect(getComputedStyle(leftBody).overflowY).toBe('auto');
    expect(getComputedStyle(detail).overflowY).toBe('auto');
  });
});
