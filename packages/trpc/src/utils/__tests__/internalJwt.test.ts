import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  describe('platform Skill operation proof', () => {
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

    it('returns server-signed claims without accepting request scope as authority', async () => {
      const { signPlatformSkillOperationProof, verifyPlatformSkillOperationProof } =
        await import('../internalJwt');
      await signPlatformSkillOperationProof(input);
      jwtVerifyMock.mockResolvedValue({
        payload: { ...SignJWTMock.mock.calls.at(-1)?.[0], sub: input.userId },
      });

      await expect(verifyPlatformSkillOperationProof('proof', input.userId)).resolves.toMatchObject(
        {
          agentId: input.agentId,
          operationId: input.operationId,
          refsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          revision: input.revision,
          userId: input.userId,
        },
      );
      await expect(
        verifyPlatformSkillOperationProof('proof', 'other-user'),
      ).resolves.toBeUndefined();
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
