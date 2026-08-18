/**
 * The otpauth:// key URI the server hands us carries the **build-time** brand
 * (`BRANDING_NAME`, captured when Better Auth starts — see the `twoFactor({ issuer })`
 * comment in `src/libs/better-auth/define-config.ts`). A customised deployment renames
 * itself at runtime, so the authenticator app would otherwise file the account under the
 * wrong product name — confusing, and impossible to correct after enrolment.
 *
 * Only the **label** and the `issuer` query parameter carry the brand. `secret`,
 * `algorithm`, `digits` and `period` define the code the app generates: touching any of
 * them silently produces an enrolment whose codes the server will never accept, and the
 * user only finds out when they are locked out. So this rewrite is deliberately textual —
 * it never re-serialises the query (which would re-encode other values) and never falls
 * back to a "best effort" URI: anything it cannot parse with confidence is returned
 * exactly as received.
 *
 * Key URI format: otpauth://totp/<label>?secret=…&issuer=…
 * (label is `Issuer:account`, per the Google Authenticator key-uri spec.)
 */

/** `otpauth://totp/` + label + optional query + optional fragment. */
const TOTP_URI_PATTERN = /^(otpauth:\/\/totp\/)([^#?]*)(\?[^#]*)?(#.*)?$/i;

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-escape — we cannot reason about the label, so don't touch it.
    return null;
  }
};

/**
 * Replace the `issuer` parameter in a raw query string, preserving every other parameter
 * byte-for-byte. `URLSearchParams` would re-encode `secret`'s base32 padding (`=` → `%3D`)
 * and turn spaces into `+`; not every authenticator decodes that back correctly.
 */
const rewriteIssuerParam = (rawQuery: string, encodedIssuer: string): string => {
  if (!rawQuery || rawQuery === '?') return `?issuer=${encodedIssuer}`;

  let replaced = false;
  const params = rawQuery.slice(1).split('&');
  const next = params.map((param) => {
    const equals = param.indexOf('=');
    const key = equals === -1 ? param : param.slice(0, equals);
    if (key !== 'issuer') return param;
    replaced = true;
    return `issuer=${encodedIssuer}`;
  });

  if (!replaced) next.push(`issuer=${encodedIssuer}`);

  return `?${next.join('&')}`;
};

/**
 * Point an otpauth TOTP URI at the runtime brand.
 *
 * Returns the URI unchanged when it is not a parseable `otpauth://totp/…` URI or when no
 * brand name is supplied — a slightly wrong issuer label is a cosmetic problem, a broken
 * QR code is a lockout.
 */
export const rewriteTotpBrand = (totpUri: string, brandName: string): string => {
  const brand = brandName?.trim();
  if (!totpUri || !brand) return totpUri;

  const match = TOTP_URI_PATTERN.exec(totpUri.trim());
  if (!match) return totpUri;

  const [, prefix, rawLabel, rawQuery = '', fragment = ''] = match;

  const label = safeDecode(rawLabel);
  if (label === null) return totpUri;

  // Spec label is `Issuer:account`; the colon may arrive percent-encoded and may be
  // followed by a single space. Anything after the FIRST colon is the account.
  const separator = label.indexOf(':');
  const account = separator === -1 ? label : label.slice(separator + 1).replace(/^ /, '');

  const encodedIssuer = encodeURIComponent(brand);
  const nextLabel = account ? `${encodedIssuer}:${encodeURIComponent(account)}` : encodedIssuer;

  return `${prefix}${nextLabel}${rewriteIssuerParam(rawQuery, encodedIssuer)}${fragment}`;
};

/** The base32 secret, for the manual-entry path when the camera/QR route is unavailable. */
export const extractTotpSecret = (totpUri: string): string | null => {
  if (!totpUri) return null;

  const match = TOTP_URI_PATTERN.exec(totpUri.trim());
  if (!match) return null;

  const rawQuery = match[3];
  if (!rawQuery) return null;

  for (const param of rawQuery.slice(1).split('&')) {
    const equals = param.indexOf('=');
    if (equals === -1) continue;
    if (param.slice(0, equals) !== 'secret') continue;
    const secret = safeDecode(param.slice(equals + 1));
    return secret || null;
  }

  return null;
};
