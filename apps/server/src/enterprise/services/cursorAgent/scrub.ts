import { redactSecrets } from '../networkProxy/redact';

const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER_RE = /\bBearer\s+\S+/gi;

export const REDACTED = '[REDACTED]';

/** Scrub a single string: exact session token, JWT-shaped values, Bearer, URL userinfo. */
export const scrubSecretString = (text: string, token: string): string => {
  let out = text;
  if (token) out = out.split(token).join(REDACTED);
  out = out.replaceAll(JWT_RE, REDACTED);
  out = out.replaceAll(BEARER_RE, `Bearer ${REDACTED}`);
  return redactSecrets(out);
};

/** Recursively scrub every string field, leaving non-strings unchanged. */
export const scrubJsonValue = (value: unknown, token: string): unknown => {
  if (typeof value === 'string') return scrubSecretString(value, token);
  if (Array.isArray(value)) return value.map((entry) => scrubJsonValue(entry, token));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubJsonValue(entry, token);
    }
    return out;
  }
  return value;
};
