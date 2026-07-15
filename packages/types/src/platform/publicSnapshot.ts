/**
 * Anonymous / login-safe public platform snapshot.
 * Used by login shell and branding surfaces — no secrets, no admin detail.
 */
export interface PlatformPublicLoginSnapshot {
  /** Whether "Sign in with work account" may be shown (flag + published IdP). */
  workAccountEnabled: boolean;
}

export interface PlatformPublicSnapshot {
  brandingRevision: string | null;
  /**
   * Opaque config revision shared with capability cache keys.
   */
  configRevision: string;
  login: PlatformPublicLoginSnapshot;
  /** Public display name when runtime branding is enabled; otherwise null (use built-in). */
  logoUrl: string | null;
  platformName: string | null;
}

export const DISABLED_PLATFORM_PUBLIC_SNAPSHOT: PlatformPublicSnapshot = {
  brandingRevision: null,
  configRevision: '0',
  login: {
    workAccountEnabled: false,
  },
  logoUrl: null,
  platformName: null,
};
