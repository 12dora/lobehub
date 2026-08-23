// @vitest-environment node
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { verifySecretReferenceDomains } from './invariants.secrets';

const makeClient = (options?: {
  aiDangling?: boolean;
  aiMismatch?: boolean;
  identityDangling?: boolean;
}) => {
  const aiDangling = options?.aiDangling ?? false;
  const aiMismatch = options?.aiMismatch ?? false;
  const identityDangling = options?.identityDangling ?? false;
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM platform_identity_providers ORDER BY id')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM platform_identity_provider_secrets ORDER BY id')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM platform_identity_provider_secrets h')) {
      return Promise.resolve({ rows: [{ n: identityDangling ? '1' : '0' }] });
    }
    if (sql.includes('FROM platform_ai_providers ORDER BY id')) {
      return Promise.resolve({
        rows: aiMismatch ? [{ fingerprint: 'current', id: 'ai-1', key_id: null }] : [],
      });
    }
    if (sql.includes('FROM platform_ai_provider_secrets ORDER BY id')) {
      return Promise.resolve({
        rows: aiMismatch
          ? [
              {
                ciphertext: 'ciphertext',
                fingerprint: 'old',
                id: 'aih-1',
                key_id: 'key-1',
                provider_id: 'ai-1',
              },
            ]
          : [],
      });
    }
    if (sql.includes('FROM platform_ai_provider_secrets h')) {
      return Promise.resolve({ rows: [{ n: aiDangling ? '1' : '0' }] });
    }
    if (sql.includes('FROM platform_connectors ORDER BY id')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM platform_connector_secrets ORDER BY id')) {
      return Promise.resolve({ rows: [] });
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  return { query } as unknown as PoolClient;
};

describe('verifySecretReferenceDomains', () => {
  it('does not report an IdP dangling secret as an AI domain mismatch', async () => {
    // A dangling IdP row is aggregate corruption, not an AI-domain mismatch.
    const result = await verifySecretReferenceDomains(makeClient({ identityDangling: true }));

    expect(result.dangling).toBe(true);
    expect(result.domains.identity.match).toBe(false);
    expect(result.domains.ai.match).toBe(true);
    expect(result.match).toBe(false);
  });

  it('keeps a genuine AI history mismatch failed', async () => {
    const result = await verifySecretReferenceDomains(makeClient({ aiMismatch: true }));

    expect(result.domains.ai.match).toBe(false);
    expect(result.match).toBe(false);
  });

  it('still fails the AI domain on an orphaned AI secret', async () => {
    // The half the domain-isolation fix must NOT have thrown away: an AI orphan is the AI
    // domain's own problem, and it has to keep failing there and in the aggregate.
    const result = await verifySecretReferenceDomains(makeClient({ aiDangling: true }));

    expect(result.dangling).toBe(true);
    expect(result.domains.ai.match).toBe(false);
    expect(result.match).toBe(false);
  });

  it('fails both domains when each has its own orphan', async () => {
    const result = await verifySecretReferenceDomains(
      makeClient({ aiDangling: true, identityDangling: true }),
    );

    expect(result.domains.ai.match).toBe(false);
    expect(result.domains.identity.match).toBe(false);
    expect(result.match).toBe(false);
  });
});
