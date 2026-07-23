import { z } from 'zod';

/**
 * Platform-level authentication / registration settings (single logical row).
 *
 * These are system-wide, admin-managed toggles — NOT per-user settings. They are
 * read at request time by the sign-up guard and projected (only `openRegistration`)
 * into the anonymous public snapshot so the login page can hide the sign-up link.
 */
export interface PlatformAuthSettings {
  /** When ON, only emails whose domain matches {@link emailDomainAllowlist} may self-register. */
  emailDomainAllowlist: string[];
  emailDomainAllowlistEnabled: boolean;
  /** When OFF, self-service email/password sign-up is hidden and rejected on the backend. */
  openRegistration: boolean;
}

/** A single allowlist entry: a bare domain `example.com` or a wildcard `*.example.com`. */
const domainEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, {
    message: 'INVALID_EMAIL_DOMAIN',
  });

export const platformAuthSettingsSchema = z
  .object({
    emailDomainAllowlist: z.array(domainEntrySchema).max(200),
    emailDomainAllowlistEnabled: z.boolean(),
    openRegistration: z.boolean(),
  })
  .strict();

export const DEFAULT_PLATFORM_AUTH_SETTINGS: PlatformAuthSettings = {
  emailDomainAllowlist: [],
  emailDomainAllowlistEnabled: false,
  openRegistration: true,
};

/**
 * Normalize free-form admin input (a raw string or an array) into a clean, de-duplicated
 * lowercase domain list. Splits on commas / whitespace / newlines and strips a leading `@`.
 */
export const normalizeEmailDomainAllowlist = (input: string | readonly string[]): string[] => {
  const parts = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const value = raw.trim().toLowerCase().replace(/^@/, '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

/** Match a single email domain against one allowlist pattern (`*.x` = x and its subdomains). */
const domainMatchesPattern = (domain: string, pattern: string): boolean => {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return domain === pattern;
};

/**
 * Whether an email is permitted by the domain allowlist.
 * An empty list means "no restriction" (returns true).
 */
export const isEmailDomainAllowed = (email: string, allowlist: readonly string[]): boolean => {
  if (allowlist.length === 0) return true;
  const domain = email.split('@').pop()?.trim().toLowerCase();
  if (!domain) return false;
  return allowlist.some((pattern) => domainMatchesPattern(domain, pattern));
};
