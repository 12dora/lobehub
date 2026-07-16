// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  containsSensitiveMaterial,
  createBrandingPointerAdapter,
  PlatformRevisionConflictError,
  PlatformRevisionImmutableError,
  PlatformRevisionModel,
  redactSensitive,
} from '../platform';

const serverDB: LobeChatDatabase = await getTestDB();
const revisionModel = new PlatformRevisionModel(serverDB);

let brandingId: string;

beforeEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformBranding);

  const [row] = await serverDB
    .insert(platformBranding)
    .values({
      displayName: 'AIHub',
      revision: 0,
      status: 'draft',
    })
    .returning();
  brandingId = row.id;
});

afterEach(async () => {
  await serverDB.delete(platformAuditLogs);
  await serverDB.delete(platformResourceRevisions);
  await serverDB.delete(platformBranding);
});

describe('PlatformRevisionModel', () => {
  describe('publishDraft', () => {
    it('preserves explicitly benign model token limits while still redacting secrets', async () => {
      const benign = new Set(['contextwindowtokens', 'maxtokens']);
      const result = await revisionModel.publishDraft({
        expectedRevision: 0,
        payload: {
          apiKey: 'fake-secret',
          contextWindowTokens: 128_000,
          parameters: { maxTokens: 4096 },
        },
        pointer: createBrandingPointerAdapter(brandingId),
        redactionOptions: {
          isBenignKey: (key) => benign.has(key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()),
        },
        resourceId: brandingId,
        resourceType: 'branding',
      });
      expect(result.revision.payload).toEqual({
        apiKey: '[REDACTED]',
        contextWindowTokens: 128_000,
        parameters: { maxTokens: 4096 },
      });
    });

    it('atomically writes revision, updates pointer, and appends audit', async () => {
      const result = await revisionModel.publishDraft({
        actorUserId: 'admin-1',
        comment: 'initial publish',
        expectedRevision: 0,
        payload: { displayName: 'AIHub', themeDefaults: { primary: '#000' } },
        pointer: createBrandingPointerAdapter(brandingId),
        reason: 'bootstrap',
        requestId: 'req-1',
        resourceId: brandingId,
        resourceType: 'branding',
      });

      expect(result.revision.revision).toBe(1);
      expect(result.revision.status).toBe('published');
      expect(result.revision.payload).toMatchObject({ displayName: 'AIHub' });
      expect(result.revision.checksum).toHaveLength(64);
      expect(result.auditId).toMatch(/^paud_/);

      const head = await serverDB.query.platformBranding.findFirst({
        where: eq(platformBranding.id, brandingId),
      });
      expect(head?.revision).toBe(1);
      expect(head?.status).toBe('published');

      const audits = await serverDB.query.platformAuditLogs.findMany();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'platform.branding.publish',
        actorUserId: 'admin-1',
        configRevision: 1,
        result: 'success',
        targetId: brandingId,
        targetType: 'branding',
      });
    });

    it('uses payload prepared after pointer lock while preserving legacy pointer adapters', async () => {
      const basePointer = createBrandingPointerAdapter(brandingId);
      const result = await revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'stale caller snapshot' },
        pointer: {
          ...basePointer,
          prepareLockedPublish: async (_tx, { currentRevision }) => ({
            afterDiff: { source: 'locked-state' },
            payload: { displayName: 'locked payload', observedRevision: currentRevision },
          }),
        },
        resourceId: brandingId,
        resourceType: 'branding',
      });

      expect(result.revision.payload).toEqual({
        displayName: 'locked payload',
        observedRevision: 0,
      });
      const audit = await serverDB.query.platformAuditLogs.findFirst({
        where: eq(platformAuditLogs.id, result.auditId),
      });
      expect(audit?.afterDiff).toEqual({ source: 'locked-state' });
    });

    it('rolls back revision, pointer and audit when locked-state assertion rejects', async () => {
      const basePointer = createBrandingPointerAdapter(brandingId);
      await expect(
        revisionModel.publishDraft({
          expectedRevision: 0,
          payload: { displayName: 'must not publish' },
          pointer: {
            ...basePointer,
            assertLockedState: async () => {
              throw new PlatformRevisionConflictError('locked state changed');
            },
          },
          resourceId: brandingId,
          resourceType: 'branding',
        }),
      ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

      const [head, revisions, audits] = await Promise.all([
        serverDB.query.platformBranding.findFirst({
          where: eq(platformBranding.id, brandingId),
        }),
        serverDB.query.platformResourceRevisions.findMany(),
        serverDB.query.platformAuditLogs.findMany(),
      ]);
      expect(head?.revision).toBe(0);
      expect(revisions).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('returns PLATFORM_REVISION_CONFLICT when expectedRevision mismatches', async () => {
      await revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'v1' },
        pointer: createBrandingPointerAdapter(brandingId),
        resourceId: brandingId,
        resourceType: 'branding',
      });

      await expect(
        revisionModel.publishDraft({
          expectedRevision: 0, // stale
          payload: { displayName: 'stale' },
          pointer: createBrandingPointerAdapter(brandingId),
          resourceId: brandingId,
          resourceType: 'branding',
        }),
      ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

      await expect(
        revisionModel.publishDraft({
          expectedRevision: 0,
          payload: { displayName: 'stale' },
          pointer: createBrandingPointerAdapter(brandingId),
          resourceId: brandingId,
          resourceType: 'branding',
        }),
      ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });

      // pointer and revision count unchanged by the failed attempts
      const head = await serverDB.query.platformBranding.findFirst({
        where: eq(platformBranding.id, brandingId),
      });
      expect(head?.revision).toBe(1);

      const revs = await serverDB.query.platformResourceRevisions.findMany();
      expect(revs).toHaveLength(1);
    });

    it('allows only one of two concurrent-style publishes with the same expectedRevision', async () => {
      // Simulate race: both readers observed expectedRevision=0; first wins, second conflicts.
      const pointer = createBrandingPointerAdapter(brandingId);
      const first = revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'winner' },
        pointer,
        resourceId: brandingId,
        resourceType: 'branding',
      });
      const second = revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'loser' },
        pointer,
        resourceId: brandingId,
        resourceType: 'branding',
      });

      const results = await Promise.allSettled([first, second]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        PlatformRevisionConflictError,
      );

      const revs = await serverDB.query.platformResourceRevisions.findMany();
      expect(revs).toHaveLength(1);
      expect(revs[0].payload).toMatchObject({ displayName: 'winner' });
    });

    it('redacts secrets from revision payload and audit diffs', async () => {
      // Synthetic placeholders only — never real credentials.
      const dirtyPayload = {
        displayName: 'AIHub',
        apiKey: 'sk-this-is-a-fake-test-key-not-real',
        clientSecret: 'fake-client-secret-value',
        token: 'fake-oauth-token-value',
        nested: {
          authorization: 'Bearer fake-token-abc',
          headers: { Authorization: 'Bearer fake-token-xyz' },
        },
      };

      const result = await revisionModel.publishDraft({
        afterDiff: dirtyPayload,
        beforeDiff: { apiKey: 'sk-old-fake-key-not-real', token: 'old-fake-token' },
        expectedRevision: 0,
        payload: dirtyPayload,
        pointer: createBrandingPointerAdapter(brandingId),
        resourceId: brandingId,
        resourceType: 'branding',
      });

      expect(containsSensitiveMaterial(result.revision.payload)).toBe(false);
      expect(result.revision.payload).toMatchObject({
        apiKey: '[REDACTED]',
        clientSecret: '[REDACTED]',
        displayName: 'AIHub',
        token: '[REDACTED]',
      });

      const audit = await serverDB.query.platformAuditLogs.findFirst({
        where: eq(platformAuditLogs.id, result.auditId),
      });
      expect(audit).toBeDefined();
      expect(containsSensitiveMaterial(audit?.beforeDiff)).toBe(false);
      expect(containsSensitiveMaterial(audit?.afterDiff)).toBe(false);
      expect(JSON.stringify(audit)).not.toMatch(
        /sk-this-is-a-fake|fake-client-secret|Bearer fake/i,
      );
      expect(JSON.stringify(audit)).not.toMatch(/apiKey":"(?!\[REDACTED\])/);
    });

    it('rolls back the full transaction if the pointer update fails', async () => {
      const failingPointer = {
        lockAndGetRevision: async () => 0,
        updatePointer: async () => {
          throw new Error('pointer boom');
        },
      };

      await expect(
        revisionModel.publishDraft({
          expectedRevision: 0,
          payload: { displayName: 'x' },
          pointer: failingPointer,
          resourceId: brandingId,
          resourceType: 'branding',
        }),
      ).rejects.toThrow('pointer boom');

      const revs = await serverDB.query.platformResourceRevisions.findMany();
      const audits = await serverDB.query.platformAuditLogs.findMany();
      const head = await serverDB.query.platformBranding.findFirst({
        where: eq(platformBranding.id, brandingId),
      });

      expect(revs).toHaveLength(0);
      expect(audits).toHaveLength(0);
      expect(head?.revision).toBe(0);
    });
  });

  describe('rollbackToRevision', () => {
    it('restores a historical payload as a new published head', async () => {
      const pointer = createBrandingPointerAdapter(brandingId);

      await revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'v1' },
        pointer,
        resourceId: brandingId,
        resourceType: 'branding',
      });
      await revisionModel.publishDraft({
        expectedRevision: 1,
        payload: { displayName: 'v2' },
        pointer,
        resourceId: brandingId,
        resourceType: 'branding',
      });

      const rolled = await revisionModel.rollbackToRevision({
        actorUserId: 'admin-1',
        expectedRevision: 2,
        pointer,
        reason: 'bad release',
        resourceId: brandingId,
        resourceType: 'branding',
        targetRevision: 1,
      });

      expect(rolled.revision.revision).toBe(3);
      expect(rolled.revision.payload).toMatchObject({ displayName: 'v1' });

      const snapshot = await revisionModel.getPublishedSnapshot('branding', brandingId);
      expect(snapshot?.revision).toBe(3);
      expect(snapshot?.payload).toMatchObject({ displayName: 'v1' });

      const head = await serverDB.query.platformBranding.findFirst({
        where: eq(platformBranding.id, brandingId),
      });
      expect(head?.revision).toBe(3);
    });
  });

  describe('immutability', () => {
    it('rejects in-place mutation of a published revision', async () => {
      const { revision } = await revisionModel.publishDraft({
        expectedRevision: 0,
        payload: { displayName: 'locked' },
        pointer: createBrandingPointerAdapter(brandingId),
        resourceId: brandingId,
        resourceType: 'branding',
      });

      await expect(revisionModel.assertImmutable(revision.id)).rejects.toBeInstanceOf(
        PlatformRevisionImmutableError,
      );
    });
  });
});

describe('redactSensitive', () => {
  it('strips API keys, client secrets, tokens, and Authorization headers', () => {
    const input = {
      apiKey: 'sk-fake-not-real-0001',
      client_secret: 'fake-secret',
      nested: {
        Authorization: 'Bearer fake-token',
        token: 'fake-token-2',
        safe: 'ok',
      },
    };
    const out = redactSensitive(input);
    expect(out).toEqual({
      apiKey: '[REDACTED]',
      client_secret: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        safe: 'ok',
        token: '[REDACTED]',
      },
    });
    expect(containsSensitiveMaterial(out)).toBe(false);
  });

  it('redacts camelCase OAuth / cloud secret key variants by normalized matching', () => {
    // Synthetic opaque values only — no real credentials.
    const input = {
      accessToken: 'opaque-oauth-access-token-not-prefixed',
      apiToken: 'opaque-api-token-value',
      authorizationHeader: 'custom-auth-header-value',
      awsSecretAccessKey: '[REDACTED]',
      displayName: 'keep-me',
      idToken: 'opaque-oidc-id-token-value',
      openaiApiKey: '[REDACTED]',
      sessionToken: 'opaque-session-token-value',
      xApiKey: 'opaque-x-api-key-value',
    };
    const out = redactSensitive(input);
    expect(out).toEqual({
      accessToken: '[REDACTED]',
      apiToken: '[REDACTED]',
      authorizationHeader: '[REDACTED]',
      awsSecretAccessKey: '[REDACTED]',
      displayName: 'keep-me',
      idToken: '[REDACTED]',
      openaiApiKey: '[REDACTED]',
      sessionToken: '[REDACTED]',
      xApiKey: '[REDACTED]',
    });
    expect(containsSensitiveMaterial(out)).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/opaque-|FAKESECRET|not-prefixed/i);
  });
});
