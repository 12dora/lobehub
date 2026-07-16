import { M07_REDACTION_OPTIONS, redactForAudit } from '../../security/redaction';
import { credentialStringLeaves } from './credentialAdapter';

export const sanitizeAiCatalogPersistedText = (
  text: string,
  credentialValues: unknown[] = [],
): string => {
  let sanitized = text;
  const leaves = credentialValues
    .flatMap(credentialStringLeaves)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const value of leaves) sanitized = sanitized.replaceAll(value, '[REDACTED]');
  return redactForAudit({ text: sanitized }, M07_REDACTION_OPTIONS).text.slice(0, 2000);
};
