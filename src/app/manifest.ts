import { type MetadataRoute } from 'next';

export const revalidate = 30;

const manifest = async (): Promise<MetadataRoute.Manifest> => {
  const [{ BRANDING_NAME }, { resolveServerRuntimeBranding }, { kebabCase }, { manifestModule }] =
    await Promise.all([
      import('@lobechat/business-const'),
      import('@/server/enterprise/services/branding'),
      import('es-toolkit/compat'),
      import('@/server/manifest'),
    ]);
  const branding = await resolveServerRuntimeBranding();

  // @ts-expect-error - manifestModule.generate returns extended manifest with custom properties
  return manifestModule.generate({
    description: `${branding.name} is a work-and-lifestyle space to find, build, and collaborate with agent teams that grow with you.`,
    icons: [
      {
        purpose: 'any',
        sizes: '192x192',
        url: '/icons/icon-192x192.png',
      },
      {
        purpose: 'maskable',
        sizes: '192x192',
        url: '/icons/icon-192x192.maskable.png',
      },
      {
        purpose: 'any',
        sizes: '512x512',
        url: '/icons/icon-512x512.png',
      },
      {
        purpose: 'maskable',
        sizes: '512x512',
        url: '/icons/icon-512x512.maskable.png',
      },
    ],
    iconUrl: branding.iconUrl ?? branding.logoUrl,
    iconRevision: branding.publishedRevision,
    // The install identity is build-stable; changing Published branding must not fork the PWA.
    id: kebabCase(BRANDING_NAME),
    name: branding.name,
    screenshots:
      branding.iconUrl || branding.logoUrl
        ? []
        : [
            {
              form_factor: 'narrow',
              url: '/screenshots/shot-1.mobile.png',
            },
            {
              form_factor: 'narrow',
              url: '/screenshots/shot-2.mobile.png',
            },
            {
              form_factor: 'narrow',
              url: '/screenshots/shot-3.mobile.png',
            },
            {
              form_factor: 'narrow',
              url: '/screenshots/shot-4.mobile.png',
            },
            {
              form_factor: 'narrow',
              url: '/screenshots/shot-5.mobile.png',
            },
            {
              form_factor: 'wide',
              url: '/screenshots/shot-1.desktop.png',
            },
            {
              form_factor: 'wide',
              url: '/screenshots/shot-2.desktop.png',
            },
            {
              form_factor: 'wide',
              url: '/screenshots/shot-3.desktop.png',
            },
            {
              form_factor: 'wide',
              url: '/screenshots/shot-4.desktop.png',
            },
            {
              form_factor: 'wide',
              url: '/screenshots/shot-5.desktop.png',
            },
          ],
    shortName: branding.shortName ?? undefined,
  });
};

export default manifest;
