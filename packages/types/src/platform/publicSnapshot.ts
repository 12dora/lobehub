import { z } from 'zod';

import {
  platformBrandingAssetUrlSchema,
  platformBrandingNameSchema,
  platformBrandingPublishedSchema,
} from './branding';

/** Anonymous / login-safe snapshot. Secrets and admin metadata are never included. */
export const platformPublicSnapshotSchema = z
  .object({
    branding: platformBrandingPublishedSchema.nullable(),
    brandingRevision: z.string().trim().min(1).max(64).nullable(),
    configRevision: z.string().trim().min(1).max(128),
    login: z
      .object({
        /**
         * Whether self-service email/password sign-up is offered (admin toggle).
         * Defaults to open so snapshots serialized before this field existed still
         * parse (and degrade to "registration available"); the backend guard is the
         * real gate.
         */
        openRegistration: z.boolean().default(true),
        workAccountEnabled: z.boolean(),
      })
      .strict(),
    /** Compatibility projection for shells that do not consume `branding` yet. */
    logoUrl: platformBrandingAssetUrlSchema.nullable(),
    platformName: platformBrandingNameSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const revision = snapshot.branding?.revision ?? null;
    const logoUrl = snapshot.branding?.logoUrl ?? null;
    const platformName = snapshot.branding?.name ?? null;

    if (revision !== snapshot.brandingRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Branding revision does not match the published branding payload',
        path: ['brandingRevision'],
      });
    }
    if (logoUrl !== snapshot.logoUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility logo URL does not match the published branding payload',
        path: ['logoUrl'],
      });
    }
    if (platformName !== snapshot.platformName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Compatibility platform name does not match the published branding payload',
        path: ['platformName'],
      });
    }
  });

export type PlatformPublicSnapshot = z.infer<typeof platformPublicSnapshotSchema>;
export type PlatformPublicLoginSnapshot = PlatformPublicSnapshot['login'];

export const DISABLED_PLATFORM_PUBLIC_SNAPSHOT: PlatformPublicSnapshot = {
  branding: null,
  brandingRevision: null,
  configRevision: '0',
  login: {
    // Registration defaults to open so the sign-up link stays available when the
    // platform feature is disabled; the backend guard remains the real gate.
    openRegistration: true,
    workAccountEnabled: false,
  },
  logoUrl: null,
  platformName: null,
};

/** Fail-closed boundary for HTML-injected or remotely fetched anonymous snapshots. */
export const resolveSafePlatformPublicSnapshot = (value: unknown): PlatformPublicSnapshot => {
  const parsed = platformPublicSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DISABLED_PLATFORM_PUBLIC_SNAPSHOT };
};
