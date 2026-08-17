import { describe, expect, it } from 'vitest';

import {
  adminSystemCancelJobInputSchema,
  adminSystemGetInfraSettingsOutputSchema,
  adminSystemGetInstanceRevisionsInputSchema,
  adminSystemGetJobsOutputSchema,
  adminSystemGetStatusOutputSchema,
  adminSystemJobKindSchema,
  adminSystemRequestRestartOutputSchema,
  adminSystemTestDependencyInputSchema,
  adminSystemTestDependencyOutputSchema,
  adminSystemUpdateInfraSettingsInputSchema,
} from './adminSystem';

describe('admin system restart acceptance output', () => {
  it('requires durable acceptance time and exact target revision evidence', () => {
    const accepted = {
      accepted: true,
      acceptedAt: new Date('2026-07-19T00:00:00Z'),
      convergenceDeadlineAt: new Date('2026-07-19T00:02:00Z'),
      duplicate: false,
      expectedIdentityRevision: 'a'.repeat(64),
      remainingMs: 120_000,
      requestId: '550e8400-e29b-41d4-a716-446655440056',
      serverNow: new Date('2026-07-19T00:00:00Z'),
      status: 'accepted',
    };
    expect(adminSystemRequestRestartOutputSchema.parse(accepted)).toEqual(accepted);
    const { acceptedAt: _acceptedAt, ...withoutAcceptedAt } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutAcceptedAt)).toThrow();
    const { expectedIdentityRevision: _revision, ...withoutRevision } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutRevision)).toThrow();
  });
});

describe('admin system operational contracts', () => {
  it('accepts only the fixed status inventory and rejects extra deployment details', () => {
    const status = {
      build: { gitSha: 'abcdef1', version: '2.0.0' },
      dependencies: Object.fromEntries(
        ['database', 'keyManagement', 'mail', 'objectStorage', 'redis'].map((key) => [
          key,
          { errorCategory: null, status: 'healthy' },
        ]),
      ),
      domains: [],
      featureFlags: {
        databaseOidc: true,
        managedAgents: true,
        managedAi: true,
        managedConnectors: true,
        managedSkills: true,
        platformAdmin: true,
        runtimeBranding: true,
        settingsPolicy: true,
      },
      instanceStatus: { errorCategory: null, status: 'healthy' },
      jobs: {
        active: 2,
        completed: 3,
        errorCategory: null,
        failed: 1,
        status: 'healthy',
        total: 6,
      },
      oidc: {
        activeRevision: 'a'.repeat(64),
        configured: true,
        pendingRestart: false,
        source: 'database',
        status: 'healthy',
      },
      recentPublishFailures: {
        count: 1,
        errorCategory: null,
        items: [
          {
            category: 'validation',
            domain: 'settings',
            occurredAt: new Date('2026-07-20T00:00:00Z'),
          },
        ],
        status: 'healthy',
      },
      snapshotAt: new Date('2026-07-20T00:01:00Z'),
    };

    expect(adminSystemGetStatusOutputSchema.parse(status)).toEqual(status);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({ ...status, databaseUrl: 'postgres://secret' })
        .success,
    ).toBe(false);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({
        ...status,
        build: { gitSha: 'not-a-sha', version: '2.0.0' },
      }).success,
    ).toBe(false);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({
        ...status,
        featureFlags: { ...status.featureFlags, arbitraryFlag: true },
      }).success,
    ).toBe(false);
    expect(
      adminSystemGetStatusOutputSchema.safeParse({
        ...status,
        jobs: { ...status.jobs, errorCategory: null, status: 'unavailable' },
      }).success,
    ).toBe(false);
  });

  it('keeps the job DTO strict and free of raw job payload fields', () => {
    const job = {
      attempt: 1,
      canCancel: false,
      canRetry: true,
      createdAt: new Date('2026-07-20T00:00:00Z'),
      errorCategory: 'operation_failed',
      failedCount: 2,
      finishedAt: new Date('2026-07-20T00:02:00Z'),
      jobId: 'pjob_1234567890abcdef',
      kind: 'agent_rollout',
      maxAttempts: 3,
      progress: { done: 8, total: 10 },
      revision: 2,
      startedAt: new Date('2026-07-20T00:01:00Z'),
      status: 'failed',
      typeId: 'platform.agent.rollout.v1',
      updatedAt: new Date('2026-07-20T00:02:00Z'),
    };

    expect(adminSystemGetJobsOutputSchema.parse({ items: [job], nextCursor: null })).toEqual({
      items: [job],
      nextCursor: null,
    });
    for (const field of [
      'cursor',
      'idempotencyKey',
      'input',
      'lastError',
      'leaseOwner',
      'requestedBy',
      'resultSummary',
      'type',
    ]) {
      expect(
        adminSystemGetJobsOutputSchema.safeParse({
          items: [{ ...job, [field]: 'sensitive' }],
          nextCursor: null,
        }).success,
      ).toBe(false);
    }
    // Every published kind must round-trip, and a malformed raw type degrades to null.
    for (const kind of adminSystemJobKindSchema.options) {
      expect(
        adminSystemGetJobsOutputSchema.safeParse({
          items: [{ ...job, kind, typeId: null }],
          nextCursor: null,
        }).success,
      ).toBe(true);
    }
    expect(
      adminSystemGetJobsOutputSchema.safeParse({
        items: [{ ...job, typeId: 'Platform.Job WITH spaces' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('defaults instance listing to a bounded state filter and rejects unknown states', () => {
    expect(adminSystemGetInstanceRevisionsInputSchema.parse(undefined)).toBeUndefined();
    expect(
      adminSystemGetInstanceRevisionsInputSchema.parse({ limit: 50, state: 'offline' }),
    ).toEqual({ limit: 50, state: 'offline' });
    expect(adminSystemGetInstanceRevisionsInputSchema.safeParse({ state: 'stale' }).success).toBe(
      false,
    );
  });

  it('requires bounded intent evidence for job mutation inputs', () => {
    const input = {
      expectedRevision: 3,
      expectedStatus: 'running',
      jobId: 'pjob_1234567890abcdef',
      reason: 'operator cancelled stalled rollout',
      requestId: '550e8400-e29b-41d4-a716-446655440056',
    };
    expect(adminSystemCancelJobInputSchema.parse(input)).toEqual(input);
    expect(
      adminSystemCancelJobInputSchema.safeParse({ ...input, reason: 'Bearer secret-token' })
        .success,
    ).toBe(false);
    expect(
      adminSystemCancelJobInputSchema.safeParse({ ...input, expectedStatus: 'succeeded' }).success,
    ).toBe(false);
  });
});

describe('admin system infrastructure settings contracts', () => {
  const settings = {
    mail: {
      enabled: false,
      errorCategory: null,
      fromAddress: 'noreply@example.com',
      hasResendApiKey: false,
      hasSmtpPass: true,
      host: 'smtp.example.com',
      port: 587,
      provider: 'smtp',
      revision: 0,
      secure: true,
      senderName: 'Platform',
      smtpUser: 'smtp-user',
      source: 'env',
      status: 'disabled',
    },
    objectStorage: {
      accessId: 'AKIA****MPLE',
      bucket: 'files',
      enabled: false,
      endpoint: 'https://s3.example.com',
      errorCategory: 'passive_check_only',
      hasSecretAccessKey: true,
      pathStyle: true,
      previewUrlExpireIn: 7200,
      publicDomain: 'https://cdn.example.com',
      region: 'us-east-1',
      revision: 0,
      setAcl: false,
      source: 'env',
      status: 'unknown',
    },
    snapshotAt: new Date('2026-08-17T00:00:00.000Z'),
  };

  it('accepts the masked overview and rejects extra secret-bearing fields', () => {
    expect(adminSystemGetInfraSettingsOutputSchema.parse(settings)).toEqual(settings);
    expect(
      adminSystemGetInfraSettingsOutputSchema.safeParse({
        ...settings,
        keyManagement: {
          errorCategory: 'passive_check_only',
          keyId: 'env:default',
          masterKeyConfigured: true,
          provider: 'env',
          status: 'unknown',
          vaultAddress: null,
        },
      }).success,
    ).toBe(false);
    expect(
      adminSystemGetInfraSettingsOutputSchema.safeParse({
        ...settings,
        objectStorage: {
          ...settings.objectStorage,
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      }).success,
    ).toBe(false);
    expect(
      adminSystemGetInfraSettingsOutputSchema.safeParse({
        ...settings,
        mail: { ...settings.mail, password: 'smtp-pass' },
      }).success,
    ).toBe(false);
  });

  it('accepts a reason-free test probe and a bounded result', () => {
    expect(adminSystemTestDependencyInputSchema.parse({ dependency: 'objectStorage' })).toEqual({
      dependency: 'objectStorage',
    });
    expect(
      adminSystemTestDependencyInputSchema.safeParse({ dependency: 'keyManagement' }).success,
    ).toBe(false);
    expect(
      adminSystemTestDependencyInputSchema.safeParse({
        dependency: 'objectStorage',
        reason: 'probe storage',
      }).success,
    ).toBe(false);
    expect(
      adminSystemTestDependencyOutputSchema.parse({
        checkedAt: new Date('2026-08-17T00:00:01.000Z'),
        latencyMs: 42,
        message: 'timeout',
        ok: false,
      }),
    ).toMatchObject({ message: 'timeout', ok: false });
    expect(
      adminSystemTestDependencyOutputSchema.safeParse({
        checkedAt: new Date(),
        latencyMs: 1,
        message: 'stack trace at secret',
        ok: false,
      }).success,
    ).toBe(false);
  });

  it('accepts a minimal enabled:false update and still requires the full tuple on enable', () => {
    expect(
      adminSystemUpdateInfraSettingsInputSchema.parse({
        config: { enabled: false },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }),
    ).toMatchObject({
      config: { enabled: false, secretAccessKey: { action: 'keep' } },
    });
    expect(
      adminSystemUpdateInfraSettingsInputSchema.parse({
        config: { enabled: false },
        dependency: 'mail',
        expectedRevision: 0,
      }),
    ).toMatchObject({
      config: { enabled: false },
    });
    expect(
      adminSystemUpdateInfraSettingsInputSchema.safeParse({
        config: { enabled: false, accessKeyId: '' },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      adminSystemUpdateInfraSettingsInputSchema.safeParse({
        config: { enabled: true, secretAccessKey: { action: 'keep' } },
        dependency: 'objectStorage',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      adminSystemUpdateInfraSettingsInputSchema.safeParse({
        config: { enabled: true, provider: 'smtp' },
        dependency: 'mail',
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });

  it('accepts a keep/replace/clear secret action on updateInfraSettings', () => {
    const input = {
      config: {
        accessKeyId: 'AKIAEXAMPLE',
        bucket: 'files',
        enabled: true,
        endpoint: 'https://s3.example.com',
        forcePathStyle: false,
        secretAccessKey: { action: 'replace' as const, value: 'super-secret' },
        setAcl: false,
      },
      dependency: 'objectStorage' as const,
      expectedRevision: 0,
    };
    expect(adminSystemUpdateInfraSettingsInputSchema.parse(input)).toEqual(input);
    expect(
      adminSystemUpdateInfraSettingsInputSchema.safeParse({
        ...input,
        config: { ...input.config, secretAccessKey: { action: 'keep' } },
      }).success,
    ).toBe(true);
    expect(
      adminSystemTestDependencyInputSchema.parse({
        dependency: 'objectStorage',
        draft: input.config,
      }).draft,
    ).toEqual(input.config);
  });
});
