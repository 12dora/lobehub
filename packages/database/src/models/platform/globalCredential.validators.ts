import { PlatformGlobalCredentialValidationError } from './globalCredential.errors';
import { KEY_PATTERN } from './globalCredential.helpers';
import type { PlatformGlobalCredentialEnvelope } from './globalCredential.types';

export const assertKey = (key: string) => {
  if (!key || key.length > 100 || !KEY_PATTERN.test(key)) {
    throw new PlatformGlobalCredentialValidationError(
      'Credential key must be 1–100 chars of [A-Za-z0-9_-]',
    );
  }
};

export const assertName = (name: string) => {
  if (!name || name.length > 255) {
    throw new PlatformGlobalCredentialValidationError('Credential name must be 1–255 characters');
  }
};

export const assertActor = (actor: string | null | undefined) => {
  if (!actor || !actor.trim()) {
    throw new PlatformGlobalCredentialValidationError(
      'createdBy is required for staged credential uploads',
    );
  }
};

export const assertFileHashId = (fileHashId: string) => {
  if (!/^[a-f0-9]{64}$/.test(fileHashId)) {
    throw new PlatformGlobalCredentialValidationError('fileHashId must be a 64-char hex SHA-256');
  }
};

export const assertEnvelope = (envelope: PlatformGlobalCredentialEnvelope) => {
  if (!envelope.ciphertext || !envelope.keyId) {
    throw new PlatformGlobalCredentialValidationError('Secret envelope is incomplete');
  }
  if (!/^[a-f0-9]{64}$/.test(envelope.fingerprint)) {
    throw new PlatformGlobalCredentialValidationError('Secret fingerprint is invalid');
  }
};
