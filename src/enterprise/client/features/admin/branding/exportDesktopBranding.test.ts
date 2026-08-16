import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDesktopBrandingExport,
  DESKTOP_BRANDING_EXPORT_FILENAME,
  downloadDesktopBrandingExport,
} from './exportDesktopBranding';

describe('buildDesktopBrandingExport', () => {
  it('exports only the desktop package fields', () => {
    expect(
      buildDesktopBrandingExport({ iconUrl: '/f/desktop-icon', productName: 'Acme Desktop' }),
    ).toEqual({
      iconUrl: '/f/desktop-icon',
      productName: 'Acme Desktop',
    });
  });
});

describe('downloadDesktopBrandingExport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads a JSON file of the current desktop fields', () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:desktop-branding');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadDesktopBrandingExport({ iconUrl: '/f/icon', productName: 'Desk' });

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:desktop-branding');
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    expect(DESKTOP_BRANDING_EXPORT_FILENAME).toBe('desktop-branding.json');
  });
});
