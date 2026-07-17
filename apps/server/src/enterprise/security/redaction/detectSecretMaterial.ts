import { containsSensitiveMaterial, isCredentialBearingUrl, isSensitiveKey } from './redact';

const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const GCP_API_KEY_PATTERN = /\bAIza[\w-]{35}\b/;
const GCP_SERVICE_ACCOUNT_PATTERN = /["']type["']\s*:\s*["']service_account["']/i;

const extractCredentialUris = (value: string) => {
  const starts = [...value.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)].map((match) => match.index);
  return starts.map((start, index) => {
    const remainder = value.slice(start, starts[index + 1] ?? value.length);
    const boundary = remainder.search(/[\s<>"']/u);
    return remainder.slice(0, boundary < 0 ? remainder.length : boundary);
  });
};

const stringContainsEnterpriseSecret = (value: string) => {
  if (
    containsSensitiveMaterial(value) ||
    PEM_PRIVATE_KEY_PATTERN.test(value) ||
    AWS_ACCESS_KEY_PATTERN.test(value) ||
    GCP_API_KEY_PATTERN.test(value) ||
    GCP_SERVICE_ACCOUNT_PATTERN.test(value)
  ) {
    return true;
  }
  return extractCredentialUris(value).some(isCredentialBearingUrl);
};

/** M13 centralized fail-closed detector for payloads that must never persist credentials. */
export const containsEnterpriseSecretMaterial = (input: unknown): boolean => {
  const stack: unknown[] = [input];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    const value = stack.pop();
    visited += 1;
    if (typeof value === 'string') {
      if (stringContainsEnterpriseSecret(value)) return true;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key) && child !== undefined && child !== null) return true;
      stack.push(child);
    }
  }
  return stack.length > 0;
};
