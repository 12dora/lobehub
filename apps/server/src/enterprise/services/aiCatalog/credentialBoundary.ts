import { containsSensitiveMaterial, isCredentialBearingUrl } from '../../security/redaction';
import { credentialStringLeaves } from './credentialAdapter';
import { AiCatalogValidationError } from './errors';

const containsForbiddenPublicString = (value: unknown, credentialLeaves: string[]): boolean => {
  if (typeof value === 'string') {
    return (
      containsSensitiveMaterial(value) ||
      isCredentialBearingUrl(value) ||
      credentialLeaves.some((credential) => value.includes(credential))
    );
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((child) =>
    containsForbiddenPublicString(child, credentialLeaves),
  );
};

/** Fail closed when plaintext credentials are copied into revision/public catalog fields. */
export const assertAiCatalogPublicFieldsExcludeCredentials = (
  publicFields: unknown,
  credentials: unknown,
): void => {
  const credentialLeaves = [...new Set(credentialStringLeaves(credentials))].filter(Boolean);
  if (containsForbiddenPublicString(publicFields, credentialLeaves)) {
    throw new AiCatalogValidationError([
      'Provider credentials must not appear in public catalog fields',
    ]);
  }
};
