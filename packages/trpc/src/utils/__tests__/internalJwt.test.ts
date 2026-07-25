import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Must mock authEnv before importing the module under test so getJwksKey() resolves.
vi.mock('@/envs/auth', () => ({
  authEnv: {
    INTERNAL_JWT_EXPIRATION: '30s',
    JWKS_KEY: JSON.stringify({
      keys: [
        {
          alg: 'RS256',
          d: 'private-d',
          dp: 'private-dp',
          dq: 'private-dq',
          e: 'AQAB',
          kid: 'test-kid',
          kty: 'RSA',
          n: 'test-modulus',
          p: 'private-p',
          q: 'private-q',
          qi: 'private-qi',
          use: 'sig',
        },
      ],
    }),
  },
}));

// Mock jose so we never need real RSA keys.
// SignJWT is a class with a fluent builder API — every setter must return `this`
// so the chain (.setProtectedHeader().setSubject()…) doesn't break.
const signMock = vi.fn().mockResolvedValue('signed.jwt.token');
const setExpirationTimeMock = vi.fn();
const setIssuedAtMock = vi.fn();
const setSubjectMock = vi.fn();
const setProtectedHeaderMock = vi.fn();

const buildSignJWTChain = () => {
  const chain = {
    setExpirationTime: setExpirationTimeMock.mockReturnValue(undefined as any),
    setIssuedAt: setIssuedAtMock.mockReturnValue(undefined as any),
    setProtectedHeader: setProtectedHeaderMock.mockReturnValue(undefined as any),
    setSubject: setSubjectMock.mockReturnValue(undefined as any),
    sign: signMock,
  };
  // Make every setter return the same chain object so .method().method() works.
  setProtectedHeaderMock.mockReturnValue(chain);
  setSubjectMock.mockReturnValue(chain);
  setIssuedAtMock.mockReturnValue(chain);
  setExpirationTimeMock.mockReturnValue(chain);
  return chain;
};

const SignJWTMock = vi.fn();
const importJWKMock = vi.fn().mockResolvedValue('mock-crypto-key');
const jwtVerifyMock = vi.fn();

vi.mock('jose', () => ({
  SignJWT: SignJWTMock,
  importJWK: (...args: unknown[]) => importJWKMock(...args),
  jwtVerify: (...args: unknown[]) => jwtVerifyMock(...args),
}));

describe('internalJwt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importJWKMock.mockResolvedValue('mock-crypto-key');
    signMock.mockResolvedValue('signed.jwt.token');
    jwtVerifyMock.mockReset();
    SignJWTMock.mockImplementation(() => buildSignJWTChain());
  });

  describe('signUserJWT', () => {
    it('signs a JWT with 5-minute expiry and cli-sandbox purpose', async () => {
      const { signUserJWT } = await import('../internalJwt');

      const token = await signUserJWT('user-123');

      expect(token).toBe('signed.jwt.token');
      expect(SignJWTMock).toHaveBeenCalledWith({ purpose: 'cli-sandbox' });
      expect(setSubjectMock).toHaveBeenCalledWith('user-123');
      expect(setExpirationTimeMock).toHaveBeenCalledWith('5m');
      expect(signMock).toHaveBeenCalledWith('mock-crypto-key');
    });

    it('sets the protected header with RS256 and the key id', async () => {
      const { signUserJWT } = await import('../internalJwt');

      await signUserJWT('user-abc');

      expect(setProtectedHeaderMock).toHaveBeenCalledWith({ alg: 'RS256', kid: 'test-kid' });
    });

    it('calls setIssuedAt to stamp the creation time', async () => {
      const { signUserJWT } = await import('../internalJwt');

      await signUserJWT('user-abc');

      expect(setIssuedAtMock).toHaveBeenCalled();
    });

    it('honors an explicit run-length expiration (e.g. a hetero sandbox run)', async () => {
      const { signUserJWT } = await import('../internalJwt');

      await signUserJWT('user-abc', '4h');

      expect(setExpirationTimeMock).toHaveBeenCalledWith('4h');
      // Still a user-scoped token, just longer-lived.
      expect(SignJWTMock).toHaveBeenCalledWith({ purpose: 'cli-sandbox' });
    });
  });

  describe('signOperationJwt', () => {
    it('signs a JWT with 4-hour expiry and hetero-operation purpose', async () => {
      const { signOperationJwt } = await import('../internalJwt');

      const token = await signOperationJwt('user-456');

      expect(token).toBe('signed.jwt.token');
      expect(SignJWTMock).toHaveBeenCalledWith({ purpose: 'hetero-operation' });
      expect(setSubjectMock).toHaveBeenCalledWith('user-456');
      expect(setExpirationTimeMock).toHaveBeenCalledWith('4h');
      expect(signMock).toHaveBeenCalledWith('mock-crypto-key');
    });

    it('sets the protected header with RS256 and the key id', async () => {
      const { signOperationJwt } = await import('../internalJwt');

      await signOperationJwt('user-456');

      expect(setProtectedHeaderMock).toHaveBeenCalledWith({ alg: 'RS256', kid: 'test-kid' });
    });

    it('calls setIssuedAt to stamp the creation time', async () => {
      const { signOperationJwt } = await import('../internalJwt');

      await signOperationJwt('user-456');

      expect(setIssuedAtMock).toHaveBeenCalled();
    });

    it('uses a longer expiry than signUserJWT (4h vs 5m)', async () => {
      const { signOperationJwt, signUserJWT } = await import('../internalJwt');

      await signUserJWT('user-a');
      const userExpiry = setExpirationTimeMock.mock.calls.at(-1)?.[0];

      await signOperationJwt('user-b');
      const opExpiry = setExpirationTimeMock.mock.calls.at(-1)?.[0];

      expect(userExpiry).toBe('5m');
      expect(opExpiry).toBe('4h');
    });
  });

  describe('platform Skill operation proof (claim construction)', () => {
    const input = {
      agentId: 'agent-1',
      operationId: 'operation-1',
      refs: [{ checksum: 'a'.repeat(64), skillKey: 'managed.skill', version: '1.0.0' }],
      revision: 'catalog-1',
      userId: 'user-1',
    };

    it('binds the user, operation, agent, revision and canonical ref hash', async () => {
      const { signPlatformSkillOperationProof } = await import('../internalJwt');

      await signPlatformSkillOperationProof(input);

      expect(SignJWTMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-1',
          catalog_revision: 'catalog-1',
          operation_id: 'operation-1',
          purpose: 'platform-skill-operation',
          refs_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      expect(setSubjectMock).toHaveBeenCalledWith('user-1');
      expect(setExpirationTimeMock).toHaveBeenCalledWith('4h');
    });
  });

  describe('signInternalJWT', () => {
    it('signs a JWT with the internal purpose from env expiry', async () => {
      const { signInternalJWT } = await import('../internalJwt');

      const token = await signInternalJWT();

      expect(token).toBe('signed.jwt.token');
      expect(SignJWTMock).toHaveBeenCalledWith({ purpose: 'lobe-internal-call' });
      expect(setExpirationTimeMock).toHaveBeenCalledWith('30s');
    });
  });
});

/**
 * Real JOSE boundary: ephemeral RSA key, no mocks on SignJWT / jwtVerify.
 * Isolated from the mock suite above via resetModules + doUnmock.
 */
describe('platform Skill operation proof (real JOSE)', () => {
  const baseInput = {
    agentId: 'agent-1',
    operationId: 'operation-1',
    refs: [{ checksum: 'a'.repeat(64), skillKey: 'managed.skill', version: '1.0.0' }],
    revision: 'catalog-1',
    userId: 'user-1',
  };

  let signPlatformSkillOperationProof: (input: typeof baseInput) => Promise<string>;
  let verifyPlatformSkillOperationProof: (
    token: string,
    userId: string,
  ) => Promise<
    | {
        agentId: string;
        operationId: string;
        refsHash: string;
        revision: string;
        userId: string;
      }
    | undefined
  >;
  let hashPlatformSkillOperationRefs: (
    refs: Array<{ checksum: string; skillKey: string; version: string }>,
  ) => string;

  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock('jose');

    const jose = await import('jose');
    const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.alg = 'RS256';
    jwk.kid = 'integration-kid';
    jwk.use = 'sig';

    vi.doMock('@/envs/auth', () => ({
      authEnv: {
        INTERNAL_JWT_EXPIRATION: '30s',
        JWKS_KEY: JSON.stringify({ keys: [jwk] }),
      },
    }));

    const mod = await import('../internalJwt');
    signPlatformSkillOperationProof = mod.signPlatformSkillOperationProof;
    verifyPlatformSkillOperationProof = mod.verifyPlatformSkillOperationProof;
    hashPlatformSkillOperationRefs = mod.hashPlatformSkillOperationRefs;
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('signs then verifies a real token with matching claims', async () => {
    const token = await signPlatformSkillOperationProof(baseInput);
    expect(token.split('.')).toHaveLength(3);

    await expect(verifyPlatformSkillOperationProof(token, baseInput.userId)).resolves.toEqual({
      agentId: baseInput.agentId,
      operationId: baseInput.operationId,
      refsHash: hashPlatformSkillOperationRefs(baseInput.refs),
      revision: baseInput.revision,
      userId: baseInput.userId,
    });
  });

  it('rejects a tampered signature', async () => {
    const token = await signPlatformSkillOperationProof(baseInput);
    const parts = token.split('.');
    const sig = parts[2]!;
    // Flip one character in the signature segment without breaking base64url alphabet.
    const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.slice(-1);
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;

    await expect(
      verifyPlatformSkillOperationProof(tampered, baseInput.userId),
    ).resolves.toBeUndefined();
  });

  it('rejects wrong subject and wrong purpose', async () => {
    const token = await signPlatformSkillOperationProof(baseInput);
    await expect(verifyPlatformSkillOperationProof(token, 'other-user')).resolves.toBeUndefined();

    // Re-sign with a different purpose using the same JWKS (manual SignJWT).
    const jose = await import('jose');
    const jwks = JSON.parse((await import('@/envs/auth')).authEnv.JWKS_KEY!);
    const key = await jose.importJWK(jwks.keys[0], 'RS256');
    const wrongPurpose = await new jose.SignJWT({
      agent_id: baseInput.agentId,
      catalog_revision: baseInput.revision,
      operation_id: baseInput.operationId,
      purpose: 'hetero-operation',
      refs_hash: hashPlatformSkillOperationRefs(baseInput.refs),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'integration-kid' })
      .setSubject(baseInput.userId)
      .setIssuedAt()
      .setExpirationTime('4h')
      .sign(key);

    await expect(
      verifyPlatformSkillOperationProof(wrongPurpose, baseInput.userId),
    ).resolves.toBeUndefined();
  });

  it('rejects tokens missing each required claim', async () => {
    const jose = await import('jose');
    const jwks = JSON.parse((await import('@/envs/auth')).authEnv.JWKS_KEY!);
    const key = await jose.importJWK(jwks.keys[0], 'RS256');
    const refsHash = hashPlatformSkillOperationRefs(baseInput.refs);

    const claimVariants = [
      {
        agent_id: baseInput.agentId,
        catalog_revision: baseInput.revision,
        operation_id: baseInput.operationId,
        purpose: 'platform-skill-operation',
      },
      {
        catalog_revision: baseInput.revision,
        operation_id: baseInput.operationId,
        purpose: 'platform-skill-operation',
        refs_hash: refsHash,
      },
      {
        agent_id: baseInput.agentId,
        operation_id: baseInput.operationId,
        purpose: 'platform-skill-operation',
        refs_hash: refsHash,
      },
      {
        agent_id: baseInput.agentId,
        catalog_revision: baseInput.revision,
        purpose: 'platform-skill-operation',
        refs_hash: refsHash,
      },
    ] as const;

    for (const claims of claimVariants) {
      const token = await new jose.SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'integration-kid' })
        .setSubject(baseInput.userId)
        .setIssuedAt()
        .setExpirationTime('4h')
        .sign(key);
      await expect(
        verifyPlatformSkillOperationProof(token, baseInput.userId),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const token = await signPlatformSkillOperationProof(baseInput);
    // Advance past the 4h expiry.
    vi.setSystemTime(new Date('2026-01-01T05:00:01.000Z'));
    await expect(
      verifyPlatformSkillOperationProof(token, baseInput.userId),
    ).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('hashes refs order-independently and content-sensitively', () => {
    const a = { checksum: 'a'.repeat(64), skillKey: 'alpha', version: '1.0.0' };
    const b = { checksum: 'b'.repeat(64), skillKey: 'beta', version: '2.0.0' };
    expect(hashPlatformSkillOperationRefs([a, b])).toBe(hashPlatformSkillOperationRefs([b, a]));
    expect(hashPlatformSkillOperationRefs([a])).not.toBe(
      hashPlatformSkillOperationRefs([{ ...a, checksum: 'c'.repeat(64) }]),
    );
    expect(hashPlatformSkillOperationRefs([a])).not.toBe(
      hashPlatformSkillOperationRefs([{ ...a, version: '1.0.1' }]),
    );
  });
});
