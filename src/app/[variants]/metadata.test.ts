// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { generateMetadata } from './metadata';

const mocks = vi.hoisted(() => ({
  resolveServerRuntimeBranding: vi.fn(),
}));

vi.mock('@/server/enterprise/services/branding', () => ({
  resolveServerRuntimeBranding: mocks.resolveServerRuntimeBranding,
}));

vi.mock('@/server/translation', () => ({
  translation: vi.fn().mockResolvedValue({
    t: (key: string, options: { appName: string }) => `${key}:${options.appName}`,
  }),
}));

vi.mock('@/utils/server/routeVariants', () => ({
  RouteVariants: { getLocale: vi.fn().mockResolvedValue('en-US') },
}));

describe('runtime metadata', () => {
  it('uses one Published branding snapshot for title, icons and open graph', async () => {
    mocks.resolveServerRuntimeBranding.mockResolvedValue({
      faviconUrl: '/runtime-favicon.png',
      iconUrl: '/runtime-icon.png',
      logoUrl: null,
      name: 'AIHub',
      ogImageUrl: 'https://assets.example.com/og.png',
      pageTitleTemplate: '[%s] AIHub',
      shortName: 'AI',
    });

    const result = await generateMetadata({} as never);

    expect(mocks.resolveServerRuntimeBranding).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      appleWebApp: { title: 'AI' },
      icons: '/runtime-favicon.png',
      openGraph: {
        images: [{ url: 'https://assets.example.com/og.png' }],
        siteName: 'AIHub',
      },
      title: { default: 'chat.title:AIHub', template: '[%s] AIHub' },
    });
  });
});
