import { z } from 'zod';

const unicodeFormatCharacterPattern = /\p{Cf}/u;
const dangerousInvisibleCodePoints = new Set([
  0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0,
]);

const hasUnsafeUnicodeCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);

    return (
      isControl ||
      unicodeFormatCharacterPattern.test(character) ||
      dangerousInvisibleCodePoints.has(codePoint)
    );
  });

const hasUnsafeText = (value: string): boolean =>
  hasUnsafeUnicodeCharacter(value) || value.includes('<') || value.includes('>');

const hasUnsafeUrlCharacter = (value: string): boolean =>
  hasUnsafeUnicodeCharacter(value) ||
  ['<', '>', '"', "'", '`', '\\'].some((character) => value.includes(character));

const decodePathnameToStable = (pathname: string): string | null => {
  let decoded = pathname;
  for (let attempt = 0; attempt < 8; attempt++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }

  // Reject inputs that keep changing rather than trusting a partially decoded path.
  return null;
};

const brandingText = (maximum: number) =>
  z
    .string()
    .transform((value) => value.trim().normalize('NFC'))
    .pipe(
      z
        .string()
        .min(1)
        .max(maximum)
        .refine((value) => !hasUnsafeText(value), {
          message: 'Branding text contains unsafe characters',
        }),
    );

export const platformBrandingNameSchema = brandingText(120);

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
        const decodedPathname = decodePathnameToStable(pathname);

        return decodedPathname !== null && !/\.svgz?$/i.test(decodedPathname);
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
    name: platformBrandingNameSchema.nullable(),
    ogImageUrl: nullableAssetUrl,
    pageTitleTemplate: nullableText(200),
    privacyUrl: nullableLinkUrl,
    shortName: nullableText(64),
    supportUrl: nullableLinkUrl,
    termsUrl: nullableLinkUrl,
  })
  .strict();

/** Platform-wide theme defaults. `null` means "no platform default; keep the product default". */
export const platformBrandingThemeDefaultsSchema = z
  .object({
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[\dA-F]{6}$/i)
      .nullable(),
  })
  .strict();

export const NO_PLATFORM_BRANDING_THEME_DEFAULTS = { primaryColor: null } as const;

/** Editable values. Publication metadata remains outside the public payload. */
export const platformBrandingDraftSchema = platformBrandingFieldsSchema.extend({
  revision: z.number().int().nonnegative(),
});

/** Sanitized public projection of one uniquely published branding revision. */
export const platformBrandingPublishedSchema = platformBrandingFieldsSchema.extend({
  name: platformBrandingNameSchema,
  revision: z.string().trim().min(1).max(64),
  // Optional so snapshots serialized before theme defaults existed still parse.
  themeDefaults: platformBrandingThemeDefaultsSchema.optional(),
});

export type PlatformBrandingDraft = z.infer<typeof platformBrandingDraftSchema>;
export type PlatformBrandingPublished = z.infer<typeof platformBrandingPublishedSchema>;
export type PlatformBrandingThemeDefaults = z.infer<typeof platformBrandingThemeDefaultsSchema>;

export interface RuntimeBranding extends Omit<PlatformBrandingPublished, 'revision'> {
  publishedRevision: string | null;
}

/** Resolves one Published revision against the immutable product fallback. */
export const resolveRuntimeBranding = (
  published: PlatformBrandingPublished | null,
  fallback: RuntimeBranding,
): RuntimeBranding => {
  if (!published) return { ...fallback, themeDefaults: { ...NO_PLATFORM_BRANDING_THEME_DEFAULTS } };

  return {
    defaultAgentDisplayName: published.defaultAgentDisplayName ?? `${published.name} AI`,
    emailFrom: published.emailFrom ?? fallback.emailFrom,
    emailSenderName: published.emailSenderName ?? published.name,
    faviconUrl: published.faviconUrl ?? fallback.faviconUrl,
    homeUrl: published.homeUrl ?? fallback.homeUrl,
    iconUrl: published.iconUrl ?? published.logoUrl ?? fallback.iconUrl,
    legalName: published.legalName ?? fallback.legalName,
    logoUrl: published.logoUrl ?? fallback.logoUrl,
    name: published.name,
    ogImageUrl: published.ogImageUrl ?? fallback.ogImageUrl,
    pageTitleTemplate: published.pageTitleTemplate?.includes('%s')
      ? published.pageTitleTemplate
      : `%s · ${published.name}`,
    privacyUrl: published.privacyUrl ?? fallback.privacyUrl,
    publishedRevision: published.revision,
    shortName: published.shortName ?? published.name,
    supportUrl: published.supportUrl ?? fallback.supportUrl,
    termsUrl: published.termsUrl ?? fallback.termsUrl,
    themeDefaults: { primaryColor: published.themeDefaults?.primaryColor ?? null },
  };
};

export const formatRuntimePageTitle = (title: string, branding: RuntimeBranding): string => {
  if (!title) return branding.name;
  if (!branding.pageTitleTemplate) return `${title} · ${branding.name}`;

  return branding.pageTitleTemplate.includes('%s')
    ? branding.pageTitleTemplate.replaceAll('%s', title)
    : `${title} · ${branding.name}`;
};
