export const DESKTOP_BRANDING_EXPORT_FILENAME = 'desktop-branding.json';

export interface DesktopBrandingExport {
  iconUrl: string | null;
  productName: string | null;
}

export const buildDesktopBrandingExport = (
  desktop: DesktopBrandingExport,
): DesktopBrandingExport => ({
  iconUrl: desktop.iconUrl,
  productName: desktop.productName,
});

/** Downloads the desktop package fields so a rebuild can consume them outside the web app. */
export const downloadDesktopBrandingExport = (desktop: DesktopBrandingExport) => {
  const blob = new Blob([`${JSON.stringify(buildDesktopBrandingExport(desktop), null, 2)}\n`], {
    type: 'application/json',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download = DESKTOP_BRANDING_EXPORT_FILENAME;
  anchor.href = objectUrl;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
};
