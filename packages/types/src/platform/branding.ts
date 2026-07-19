import { z } from 'zod';

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

const hasUnsafeText = (value: string): boolean =>
  hasControlCharacter(value) || value.includes('<') || value.includes('>');

const hasUnsafeUrlCharacter = (value: string): boolean =>
  hasControlCharacter(value) ||
  ['<', '>', '"', "'", '`', '\\'].some((character) => value.includes(character));

const decodePathname = (pathname: string): string => {
  let decoded = pathname;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
};

const brandingText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !hasUnsafeText(value), {
      message: 'Branding text contains unsafe characters',
    });

const validateHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);

    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
};

export const platformBrandingLinkUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => !hasUnsafeUrlCharacter(value) && validateHttpUrl(value), {
    message: 'Expected an absolute HTTP(S) URL without credentials',
  });

export const platformBrandingAssetUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      if (hasUnsafeUrlCharacter(value)) return false;

      const isRootRelative = value.startsWith('/') && !value.startsWith('//');
      if (!isRootRelative && !validateHttpUrl(value)) return false;

      try {
        const pathname = isRootRelative
          ? new URL(value, 'https://runtime.invalid').pathname
          : new URL(value).pathname;
        const decodedPathname = decodePathname(pathname);

        return !/\.svgz?$/i.test(decodedPathname);
      } catch {
        return false;
      }
    },
    {
      message: 'Expected a safe HTTP(S) or root-relative non-SVG asset URL',
    },
  );

const nullableText = (maximum: number) => brandingText(maximum).nullable();
const nullableAssetUrl = platformBrandingAssetUrlSchema.nullable();
const nullableLinkUrl = platformBrandingLinkUrlSchema.nullable();

const platformBrandingFieldsSchema = z
  .object({
    defaultAgentDisplayName: nullableText(120),
    emailFrom: z.string().trim().email().max(254).nullable(),
    emailSenderName: nullableText(120),
    faviconUrl: nullableAssetUrl,
    homeUrl: nullableLinkUrl,
    iconUrl: nullableAssetUrl,
    legalName: nullableText(200),
    logoUrl: nullableAssetUrl,
    name: nullableText(120),
    ogImageUrl: nullableAssetUrl,
    pageTitleTemplate: nullableText(200),
    privacyUrl: nullableLinkUrl,
    shortName: nullableText(64),
    supportUrl: nullableLinkUrl,
    termsUrl: nullableLinkUrl,
  })
  .strict();

/** Editable values. Publication metadata remains outside the public payload. */
export const platformBrandingDraftSchema = platformBrandingFieldsSchema.extend({
  revision: z.number().int().nonnegative(),
});

/** Sanitized public projection of one uniquely published branding revision. */
export const platformBrandingPublishedSchema = platformBrandingFieldsSchema.extend({
  name: brandingText(120),
  revision: z.string().trim().min(1).max(64),
});

export type PlatformBrandingDraft = z.infer<typeof platformBrandingDraftSchema>;
export type PlatformBrandingPublished = z.infer<typeof platformBrandingPublishedSchema>;
