/**
 * Automated adversarial security regression manifest.
 *
 * Repository automation only — not an external production penetration test.
 *
 * S06 admin rate-limit targets (parallel commit 5fa953ca):
 * - apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.test.ts
 * - apps/server/src/enterprise/guards/adminMutationRateLimit.test.ts
 * Until those files exist on this branch, adapters fail closed with missing-test-target.
 */
export type PenAdapterCategory =
  'admin-rate-limit' | 'auth-rbac-idor' | 'reauth' | 'replay-cas' | 'ssrf';

export interface ExpectedSkip {
  /** Stable vitest test title (assertion title, not fullName). */
  reason: string;
  title: string;
}

export interface PenAdapterDefinition {
  category: PenAdapterCategory;
  description: string;
  /**
   * Reviewed intentional skips. Unexpected skips fail closed.
   * Zero skips is always allowed.
   */
  expectedSkips?: readonly ExpectedSkip[];
  /** Stable kebab id. */
  id: string;
  /**
   * When true, missing targets or failed adapters fail the pen-regression check.
   */
  required: boolean;
  /** Relative test file paths. All must exist for the adapter to execute. */
  testFiles: readonly string[];
  vitestConfig?: string;
  workingDirectory?: string;
}

/**
 * Required pen-regression adapters. Order is stable for deterministic reports.
 */
export const PEN_REGRESSION_MANIFEST: readonly PenAdapterDefinition[] = [
  {
    id: 'ssrf-outbound',
    category: 'ssrf',
    description:
      'SSRF bypass, redirect, DNS pin, and large-response bounds on SafeOutboundHttpClient',
    required: true,
    testFiles: ['apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.test.ts'],
  },
  {
    id: 'ssrf-safe-fetch',
    category: 'ssrf',
    description: 'Package-level SSRF-safe fetch regression suite',
    expectedSkips: [
      {
        reason: 'gc-not-exposed',
        title: 'heap delta stays bounded when a 50 MB body is fetched with a 1 MB cap',
      },
    ],
    required: true,
    testFiles: ['packages/ssrf-safe-fetch/index.test.ts'],
    vitestConfig: 'vitest.config.mts',
    workingDirectory: 'packages/ssrf-safe-fetch',
  },
  {
    id: 'auth-rbac-idor',
    category: 'auth-rbac-idor',
    description: 'Admin RBAC matrix, adversarial user IDOR, and procedure authorization registry',
    required: true,
    testFiles: [
      'apps/server/src/enterprise/routers/permissionMatrix.test.ts',
      'apps/server/src/enterprise/routers/admin/users.adversarial.test.ts',
      'apps/server/src/enterprise/security/policy/adminProcedureAuthorizationRegistry.test.ts',
    ],
  },
  {
    id: 'reauth-guard',
    category: 'reauth',
    description: 'Dangerous-operation recent reauthentication guard',
    required: true,
    testFiles: ['apps/server/src/enterprise/guards/reauth.test.ts'],
  },
  {
    id: 'replay-cas',
    category: 'replay-cas',
    description: 'Draft concurrency / CAS replay resistance for admin settings publication paths',
    required: true,
    testFiles: ['apps/server/src/enterprise/services/settings/r5.draftConcurrency.test.ts'],
  },
  {
    id: 'admin-rate-limit-service',
    category: 'admin-rate-limit',
    description:
      'Admin mutation rate limiter service atomicity/boundary tests (S06 rateLimiter suite)',
    required: true,
    testFiles: ['apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.test.ts'],
  },
  {
    id: 'admin-rate-limit-guard',
    category: 'admin-rate-limit',
    description:
      'Admin mutation rate-limit middleware integration/reconciliation (S06 guard suite)',
    required: true,
    testFiles: ['apps/server/src/enterprise/guards/adminMutationRateLimit.test.ts'],
  },
] as const;

export const REQUIRED_PEN_ADAPTER_IDS = PEN_REGRESSION_MANIFEST.filter(
  (adapter) => adapter.required,
).map((adapter) => adapter.id);
