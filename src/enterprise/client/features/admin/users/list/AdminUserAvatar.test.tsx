/**
 * @vitest-environment happy-dom
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AdminUserAvatar from './AdminUserAvatar';

describe('AdminUserAvatar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the remote image hidden until it loads, so a slow CDN never shows a blank cell', () => {
    render(<AdminUserAvatar avatar={'https://cdn.example.com/a.png'} name={'接发测试员'} />);

    const img = screen.getByAltText('接发测试员');
    expect(img).toHaveStyle({ opacity: '0' });

    act(() => {
      img.dispatchEvent(new Event('load'));
    });
    expect(screen.getByAltText('接发测试员')).toHaveStyle({ opacity: '1' });
  });

  it('drops the request once the timeout elapses without a response', () => {
    render(<AdminUserAvatar avatar={'https://cdn.example.com/a.png'} name={'接发测试员'} />);
    expect(screen.queryByAltText('接发测试员')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByAltText('接发测试员')).toBeNull();
  });

  it('drops the request when the image errors', () => {
    render(<AdminUserAvatar avatar={'https://cdn.example.com/a.png'} name={'接发测试员'} />);

    act(() => {
      screen.getByAltText('接发测试员').dispatchEvent(new Event('error'));
    });
    expect(screen.queryByAltText('接发测试员')).toBeNull();
  });

  it('renders no image element at all without an avatar url', () => {
    render(<AdminUserAvatar avatar={null} name={'no-avatar'} />);
    expect(screen.queryByAltText('no-avatar')).toBeNull();
  });
});
