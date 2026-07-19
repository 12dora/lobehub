// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';

import { CIPHERTEXT_PREFIX, ENVELOPE_VERSION } from './config';
import { parseEnvelopeString } from './envelope';
import { PlatformSecretError } from './errors';
import { EnvKeyProvider } from './keyProviders';
import {
  assertPlatformMasterKeyIfEnterprise,
  PlatformSecretService,
} from './platformSecretService';

/** Explicit fake master key for tests only — never a real secret. */
const FAKE_MASTER_KEY_B64 = Buffer.alloc(32, 0xab).toString('base64');
const OTHER_MASTER_KEY_B64 = Buffer.alloc(32, 0xcd).toString('base64');

const makeService = (masterKeyBase64 = FAKE_MASTER_KEY_B64, keyId = 'env:test') =>
  new PlatformSecretService({
    keyProvider: new EnvKeyProvider({ keyId, masterKeyBase64 }),
  });

describe('PlatformSecretService', () => {
  describe('encrypt / decrypt', () => {
    it('round-trips utf8 plaintext', async () => {
      const svc = makeService();
      const plain = 'provider-api-key-fake-value-not-real';
      const ct = await svc.encrypt(plain);

      expect(ct.startsWith(`${CIPHERTEXT_PREFIX}.v${ENVELOPE_VERSION}.`)).toBe(true);
      expect(ct).not.toContain(plain);

      const out = await svc.decrypt(ct);
      expect(out).toBe(plain);
    });

    it('embeds key id for future rotation', async () => {
      const svc = makeService(FAKE_MASTER_KEY_B64, 'env:v42');
      const ct = await svc.encrypt('x');
      expect(svc.peekKeyId(ct)).toBe('env:v42');
      expect(parseEnvelopeString(ct).kid).toBe('env:v42');
      expect(parseEnvelopeString(ct).alg).toBe('A256GCM');
      expect(parseEnvelopeString(ct).v).toBe(1);
    });

    it('produces different ciphertext for the same plaintext (random DEK/IV)', async () => {
      const svc = makeService();
      const a = await svc.encrypt('same');
      const b = await svc.encrypt('same');
      expect(a).not.toBe(b);
      expect(await svc.decrypt(a)).toBe('same');
      expect(await svc.decrypt(b)).toBe('same');
    });
  });

  describe('artifact signatures', () => {
    it('uses the KeyProvider with domain separation and rejects tampering', async () => {
      const svc = makeService();
      const signature = await svc.signArtifact('platform-oidc-lkg', 'payload');

      await expect(svc.verifyArtifact('platform-oidc-lkg', 'payload', signature)).resolves.toBe(
        true,
      );
      await expect(svc.verifyArtifact('platform-oidc-lkg', 'tampered', signature)).resolves.toBe(
        false,
      );
      await expect(svc.verifyArtifact('another-domain', 'payload', signature)).resolves.toBe(false);
    });

    it('rejects signatures made by a different key', async () => {
      const signature = await makeService().signArtifact('platform-oidc-lkg', 'payload');
      await expect(
        makeService(OTHER_MASTER_KEY_B64).verifyArtifact('platform-oidc-lkg', 'payload', signature),
      ).resolves.toBe(false);
    });
  });

  describe('failure paths', () => {
    it('fails decrypt with wrong master key', async () => {
      const a = makeService(FAKE_MASTER_KEY_B64, 'env:a');
      const ct = await a.encrypt('secret-payload');

      // Same keyId label but different material → GCM auth fails
      const b = makeService(OTHER_MASTER_KEY_B64, 'env:a');
      await expect(b.decrypt(ct)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
        name: 'PlatformSecretError',
      });
    });

    it('fails decrypt when ciphertext is tampered', async () => {
      const svc = makeService();
      const ct = await svc.encrypt('tamper-me');
      // Flip last character of payload section
      const tampered = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
      await expect(svc.decrypt(tampered)).rejects.toBeInstanceOf(PlatformSecretError);
    });

    it('fails on unknown envelope version', async () => {
      const svc = makeService();
      const ct = await svc.encrypt('v');
      // Rewrite version token v1 → v99
      const bad = ct.replace('.v1.', '.v99.');
      await expect(svc.decrypt(bad)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      });
    });

    it('fails on non-envelope garbage', async () => {
      const svc = makeService();
      await expect(svc.decrypt('not-an-envelope')).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      });
    });

    it('fails when key id is unknown to provider', async () => {
      const a = makeService(FAKE_MASTER_KEY_B64, 'env:a');
      const ct = await a.encrypt('x');
      const b = makeService(FAKE_MASTER_KEY_B64, 'env:b');
      await expect(b.decrypt(ct)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
      });
    });
  });

  describe('rotate', () => {
    it('re-encrypts under a new key id with the same plaintext', async () => {
      const oldSvc = makeService(FAKE_MASTER_KEY_B64, 'env:old');
      const ct1 = await oldSvc.encrypt('rotate-me');

      // Provider that can decrypt old id and encrypt with new id
      const dualProvider = {
        providerId: 'env',
        getKek: async (keyId?: string) => {
          if (keyId === undefined || keyId === 'env:new') {
            return {
              keyId: 'env:new',
              key: new Uint8Array(Buffer.from(FAKE_MASTER_KEY_B64, 'base64')),
            };
          }
          if (keyId === 'env:old') {
            return {
              keyId: 'env:old',
              key: new Uint8Array(Buffer.from(FAKE_MASTER_KEY_B64, 'base64')),
            };
          }
          throw new PlatformSecretError(
            PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
            `unknown ${keyId}`,
          );
        },
      };

      const rotator = new PlatformSecretService({ keyProvider: dualProvider });
      const ct2 = await rotator.rotate(ct1);
      expect(ct2).not.toBe(ct1);
      expect(rotator.peekKeyId(ct2)).toBe('env:new');
      expect(await rotator.decrypt(ct2)).toBe('rotate-me');
    });
  });

  describe('startup / factory', () => {
    it('tryFromEnv returns null when master key missing', () => {
      expect(PlatformSecretService.tryFromEnv({})).toBeNull();
    });

    it('tryFromEnv builds service when key present', async () => {
      const svc = PlatformSecretService.tryFromEnv({
        PLATFORM_MASTER_KEY: FAKE_MASTER_KEY_B64,
        PLATFORM_MASTER_KEY_ID: 'env:from-env',
      });
      expect(svc).not.toBeNull();
      const ct = await svc!.encrypt('via-env');
      expect(await svc!.decrypt(ct)).toBe('via-env');
      expect(svc!.peekKeyId(ct)).toBe('env:from-env');
    });

    it('selects Vault explicitly without falling back to an available env key', () => {
      const service = PlatformSecretService.tryFromEnv({
        PLATFORM_KEY_PROVIDER: 'vault',
        PLATFORM_MASTER_KEY: FAKE_MASTER_KEY_B64,
        VAULT_TOKEN: 'scoped-test-token',
      });
      expect(service).toBeInstanceOf(PlatformSecretService);
      expect(() =>
        PlatformSecretService.tryFromEnv({
          PLATFORM_KEY_PROVIDER: 'vault',
          PLATFORM_MASTER_KEY: FAKE_MASTER_KEY_B64,
        }),
      ).toThrow(/Vault authentication/i);
    });

    it('fromEnvOrThrowIfEnterprise throws when enterprise on and key missing', () => {
      expect(() =>
        PlatformSecretService.fromEnvOrThrowIfEnterprise(
          {},
          { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_ADMIN: true },
        ),
      ).toThrow(PlatformSecretError);

      try {
        PlatformSecretService.fromEnvOrThrowIfEnterprise(
          {},
          { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_ADMIN: true },
        );
      } catch (e) {
        expect(e).toMatchObject({ code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
      }
    });

    it('fromEnvOrThrowIfEnterprise returns null when enterprise off and key missing', () => {
      const svc = PlatformSecretService.fromEnvOrThrowIfEnterprise(
        {},
        { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS },
      );
      expect(svc).toBeNull();
    });

    it('assertPlatformMasterKeyIfEnterprise no-ops when flags off', () => {
      expect(() =>
        assertPlatformMasterKeyIfEnterprise({}, { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS }),
      ).not.toThrow();
    });

    it('assertPlatformMasterKeyIfEnterprise throws when flags on and key missing', () => {
      expect(() =>
        assertPlatformMasterKeyIfEnterprise(
          {},
          { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AI: true },
        ),
      ).toThrow(/PLATFORM_MASTER_KEY|master key/i);
    });

    it('EnvKeyProvider rejects wrong key length', () => {
      expect(
        () => new EnvKeyProvider({ masterKeyBase64: Buffer.alloc(16, 1).toString('base64') }),
      ).toThrow(PlatformSecretError);
    });
  });

  it('does not embed plaintext or master key in ciphertext', async () => {
    const plain = `unique-plain-${randomBytes(8).toString('hex')}`;
    const svc = makeService();
    const ct = await svc.encrypt(plain);
    expect(ct.toLowerCase()).not.toContain(plain.toLowerCase());
    expect(ct).not.toContain(FAKE_MASTER_KEY_B64);
  });
});
