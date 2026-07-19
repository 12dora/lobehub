import qs from 'query-string';

import { getCanonicalUrl } from '@/server/utils/url';

const MAX_AGE = 31_536_000;
const COLOR = '#000000';

interface IconItem {
  purpose: 'any' | 'maskable';
  sizes: string;
  url: string;
  version?: number;
}

interface ScreenshotItem {
  form_factor: 'wide' | 'narrow';
  sizes?: string;
  url: string;
  version?: number;
}

export class Manifest {
  public generate({
    color = COLOR,
    description,
    name,
    shortName,
    id,
    icons,
    iconUrl,
    screenshots,
  }: {
    color?: string;
    description: string;
    icons: IconItem[];
    iconUrl?: string | null;
    id: string;
    name: string;
    shortName?: string;
    screenshots: ScreenshotItem[];
  }) {
    return {
      background_color: color,
      cache_busting_mode: 'all',
      categories: ['productivity', 'design', 'development', 'education'],
      description,
      display: 'standalone',
      display_override: ['tabbed'],
      edge_side_panel: {
        preferred_width: 480,
      },
      handle_links: 'auto',
      icons: icons.map((item) => this._getIcon(item, iconUrl)),
      id,
      immutable: 'true',
      max_age: MAX_AGE,
      name,
      orientation: 'portrait',
      related_applications: [
        {
          platform: 'webapp',
          url: getCanonicalUrl('manifest.webmanifest'),
        },
      ],
      scope: '/',
      screenshots: screenshots.map((item) => this._getScreenshot(item)),
      short_name: shortName ?? name,
      splash_pages: null,
      start_url: '/',
      tab_strip: {
        new_tab_button: {
          url: '/',
        },
      },
      theme_color: color,
    };
  }

  private _getImage = (url: string, version: number = 1) => ({
    cache_busting_mode: 'query',
    immutable: 'true',
    max_age: MAX_AGE,
    src: qs.stringifyUrl({ query: { v: version }, url }),
  });

  private _getIcon = ({ url, version, sizes, purpose }: IconItem, iconUrl?: string | null) => ({
    ...this._getImage(iconUrl ?? url, version),
    purpose,
    sizes,
    type: 'image/png',
  });

  private _getScreenshot = ({ form_factor, url, version, sizes }: ScreenshotItem) => ({
    ...this._getImage(url, version),
    form_factor,
    sizes: sizes ?? (form_factor === 'wide' ? '1280x676' : '640x1138'),
    type: 'image/png',
  });
}

export const manifestModule = new Manifest();
