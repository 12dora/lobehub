/**
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Locale from './Locale';

const listeners = new Map<string, Set<(lng: string) => void>>();

const i18nInstance = {
  isInitialized: false,
  language: 'zh-CN',
  off: (event: string, handler: (lng: string) => void) => {
    listeners.get(event)?.delete(handler);
  },
  on: (event: string, handler: (lng: string) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(handler);
  },
};

vi.mock('antd', async () => {
  const React = await import('react');

  return {
    ConfigProvider: ({ children, locale }: { children?: ReactNode; locale?: any }) =>
      React.createElement(
        'div',
        { 'data-locale': locale?.locale ?? '', 'data-testid': 'config-provider' },
        children,
      ),
  };
});

vi.mock('dayjs', () => ({
  default: { locale: vi.fn() },
}));

vi.mock('@/layout/GlobalProvider/Editor', async () => {
  const React = await import('react');

  return {
    default: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock('@/utils/dayjsLocale', () => ({
  loadDayjsLocaleModule: vi.fn(async () => ({ default: {} })),
  normalizeDayjsLocale: (lang: string) => lang.toLowerCase(),
}));

const getAntdLocale = vi.fn(async (lang: string) => {
  if (lang === 'zh-CN') return { locale: 'zh-cn' };
  if (lang === 'en-US') return { locale: 'en' };
  throw new Error(`Unsupported antd locale: ${lang}`);
});

vi.mock('@/utils/locale', () => ({
  getAntdLocale: (lang: string) => getAntdLocale(lang),
}));

vi.mock('@/locales/create', () => ({
  createI18nNext: () => ({
    init: () => Promise.resolve(),
    instance: i18nInstance,
  }),
}));

describe('Locale', () => {
  beforeEach(() => {
    listeners.clear();
    getAntdLocale.mockClear();
    i18nInstance.isInitialized = false;
    i18nInstance.language = 'zh-CN';
  });

  it('seeds the antd ConfigProvider locale on mount, without waiting for languageChanged', async () => {
    render(
      <Locale defaultLang="zh-CN">
        <div data-testid="child" />
      </Locale>,
    );

    // Nothing ever emits `languageChanged` here: i18next fires it synchronously inside
    // `init()`, so the mount path is the only thing that can seed antd's locale.
    expect(listeners.get('languageChanged')?.size ?? 0).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByTestId('config-provider').dataset.locale).toBe('zh-cn');
    });
    expect(getAntdLocale).toHaveBeenCalledWith('zh-CN');
  });

  it('falls back to the language i18next actually resolved', async () => {
    i18nInstance.language = 'en-US';

    render(
      <Locale defaultLang="ja-JP">
        <div data-testid="child" />
      </Locale>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('config-provider').dataset.locale).toBe('en');
    });
  });

  it('keeps rendering when antd does not ship the requested locale', async () => {
    i18nInstance.language = 'xx-XX';

    render(
      <Locale defaultLang="xx-XX">
        <div data-testid="child" />
      </Locale>,
    );

    await waitFor(() => {
      expect(getAntdLocale).toHaveBeenCalledWith('xx-XX');
    });
    expect(screen.getByTestId('child')).toBeTruthy();
    expect(screen.getByTestId('config-provider').dataset.locale).toBe('');
  });
});
