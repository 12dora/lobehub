import { M07_REDACTION_OPTIONS, redactForAudit } from '../../security/redaction';
import { credentialStringLeaves, MIN_CREDENTIAL_SUBSTRING_MATCH_LENGTH } from './credentialAdapter';

export const sanitizeAiCatalogPersistedText = (
  text: string,
  credentialValues: unknown[] = [],
): string => {
  let sanitized = text;
  const leaves = credentialValues
    .flatMap(credentialStringLeaves)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const value of leaves) {
    if (value.length < MIN_CREDENTIAL_SUBSTRING_MATCH_LENGTH) {
      // Exact occurrences only for short secrets — avoid clobbering unrelated short tokens.
      if (sanitized === value) {
        sanitized = '[REDACTED]';
        continue;
      }
      const escaped = value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replaceAll(
        new RegExp(`(^|[^A-Za-z0-9_+/=-])${escaped}(?=$|[^A-Za-z0-9_+/=-])`, 'g'),
        '$1[REDACTED]',
      );
      continue;
    }
    sanitized = sanitized.replaceAll(value, '[REDACTED]');
  }
  return redactForAudit({ text: sanitized }, M07_REDACTION_OPTIONS).text.slice(0, 2000);
};
