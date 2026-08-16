import { randomUUID } from 'node:crypto';
import pathModule from 'node:path';

import type { PlatformSecretService } from '../../../security/secret';
import { PROVIDER_TOMBSTONE_DECODE_HARD_MAX, resolveLkgPath } from './codec';
import {
  assertSecureDirectory,
  ensureExistingTargetIsSecure,
  IdentityProviderLkgError,
  type IdentityProviderLkgTestHooks,
  openAndReadSecure,
  withProcessWriteLock,
  writeSecureFileAtomically,
} from './secureFile';

const REVOCATION_JOURNAL_DOMAIN = 'platform-oidc-revocation-journal';
const REVOCATION_JOURNAL_FORMAT = 'aihub.platform.oidc-revocation-journal';

interface IdentityProviderRevocationJournalEnvelope {
  ciphertext: string;
  format: typeof REVOCATION_JOURNAL_FORMAT;
  signature: string;
  version: 1;
}

export interface IdentityProviderRevocationJournalEntry {
  /** Absent until the database tombstone commits; pending entries always fail closed. */
  generation?: string;
  providerId: string;
  token: string;
}

interface IdentityProviderRevocationJournalPayload {
  entries: IdentityProviderRevocationJournalEntry[];
  updatedAt: string;
  version: 1;
}

const resolveRevocationJournalPath = (env: Record<string, string | undefined>): string =>
  `${resolveLkgPath(env)}.revocations`;

const parseRevocationJournalPayload = (
  value: unknown,
): IdentityProviderRevocationJournalPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 3 ||
    payload.version !== 1 ||
    typeof payload.updatedAt !== 'string' ||
    Number.isNaN(new Date(payload.updatedAt).getTime()) ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > PROVIDER_TOMBSTONE_DECODE_HARD_MAX
  ) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  const entries = payload.entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    const entry = value as Record<string, unknown>;
    if (
      (Object.keys(entry).length !== 2 && Object.keys(entry).length !== 3) ||
      typeof entry.providerId !== 'string' ||
      entry.providerId.length === 0 ||
      entry.providerId.length > 255 ||
      typeof entry.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(entry.token) ||
      (entry.generation !== undefined &&
        (typeof entry.generation !== 'string' ||
          entry.generation.length === 0 ||
          entry.generation.length > 512))
    ) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    return {
      ...(typeof entry.generation === 'string' ? { generation: entry.generation } : {}),
      providerId: entry.providerId,
      token: entry.token,
    };
  });
  if (new Set(entries.map(({ token }) => token)).size !== entries.length) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  return {
    entries: [...entries].sort((left, right) => left.token.localeCompare(right.token)),
    updatedAt: payload.updatedAt,
    version: 1,
  };
};

const readRevocationJournalAtPath = async (input: {
  path: string;
  secrets: PlatformSecretService;
}): Promise<IdentityProviderRevocationJournalPayload> => {
  try {
    const raw = await openAndReadSecure(input.path);
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    const envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).length !== 4 ||
      envelope.format !== REVOCATION_JOURNAL_FORMAT ||
      envelope.version !== 1 ||
      typeof envelope.ciphertext !== 'string' ||
      typeof envelope.signature !== 'string' ||
      !(await input.secrets.verifyArtifact(
        REVOCATION_JOURNAL_DOMAIN,
        envelope.ciphertext,
        envelope.signature,
      ))
    ) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    return parseRevocationJournalPayload(
      JSON.parse(await input.secrets.decrypt(envelope.ciphertext)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], updatedAt: new Date(0).toISOString(), version: 1 };
    }
    throw error;
  }
};

const writeRevocationJournalAtPath = async (input: {
  path: string;
  payload: IdentityProviderRevocationJournalPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<void> => {
  const payload = parseRevocationJournalPayload(input.payload);
  const directory = pathModule.dirname(input.path);
  await assertSecureDirectory(directory, true);
  await ensureExistingTargetIsSecure(input.path);
  const ciphertext = await input.secrets.encrypt(JSON.stringify(payload));
  const envelope: IdentityProviderRevocationJournalEnvelope = {
    ciphertext,
    format: REVOCATION_JOURNAL_FORMAT,
    signature: await input.secrets.signArtifact(REVOCATION_JOURNAL_DOMAIN, ciphertext),
    version: 1,
  };
  await writeSecureFileAtomically({
    contents: JSON.stringify(envelope),
    path: input.path,
    testHooks: input.testHooks,
  });
};

/** Read the independently authenticated fail-closed revocation journal. */
export const readIdentityProviderRevocationJournal = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
}): Promise<IdentityProviderRevocationJournalEntry[]> => {
  const path = resolveRevocationJournalPath(input.env);
  await assertSecureDirectory(pathModule.dirname(path), false);
  return (await readRevocationJournalAtPath({ path, secrets: input.secrets })).entries;
};

/**
 * Persist a pending denial before the database tombstone is attempted.
 * The token binds later finalize/clear operations to this exact disable attempt.
 */
export const recordIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  providerId: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<string> => {
  const path = resolveRevocationJournalPath(input.env);
  const token = randomUUID();
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    await writeRevocationJournalAtPath({
      path,
      payload: {
        entries: [...current.entries, { providerId: input.providerId, token }],
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      secrets: input.secrets,
      testHooks: input.testHooks,
    });
  });
  return token;
};

/** Attach the committed immutable tombstone generation to a pending denial. */
export const finalizeIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  generation: string;
  secrets: PlatformSecretService;
  token: string;
}): Promise<void> => {
  const path = resolveRevocationJournalPath(input.env);
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    const entries = current.entries.map((entry) =>
      entry.token === input.token ? { ...entry, generation: input.generation } : entry,
    );
    if (!entries.some((entry) => entry.token === input.token)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_ENTRY_MISSING');
    }
    await writeRevocationJournalAtPath({
      path,
      payload: { entries, updatedAt: new Date().toISOString(), version: 1 },
      secrets: input.secrets,
    });
  });
};

/** Remove only the exact attempt entry after the main LKG is proven safe. */
export const clearIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
  token: string;
}): Promise<void> => {
  const path = resolveRevocationJournalPath(input.env);
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    const entries = current.entries.filter((entry) => entry.token !== input.token);
    if (entries.length === current.entries.length) return;
    await writeRevocationJournalAtPath({
      path,
      payload: { entries, updatedAt: new Date().toISOString(), version: 1 },
      secrets: input.secrets,
    });
  });
};
