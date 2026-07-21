/**
 * Automated adversarial security regression manifest.
 *
 * These are repository automation targets — not an external production penetration test.
 * `admin-rate-limit` is required and reserved for S06; missing coverage fails closed.
 */
export type PenAdapterCategory =
  'admin-rate-limit' | 'auth-rbac-idor' | 'reauth' | 'replay-cas' | 'ssrf';

export interface PenAdapterDefinition {
  category: PenAdapterCategory;
  description: string;
  /** Stable kebab id. */
  id: string;
  /**
   * When true, missing targets or failed adapters fail the pen-regression check.
   * All current adapters are required.
   */
  required: boolean;
  /**
   * Relative test file paths. All must exist for the adapter to execute.
   * Rate-limit path is reserved until S06 lands.
   */
  testFiles: readonly string[];
  /**
   * Vitest config relative to repo root. Defaults to root vitest.config.mts.
   * Package-local suites may set their own config.
   */
  vitestConfig?: string;
  /**
   * Optional working directory relative to repo root (for package-local vitest).
   */
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
    id: 'admin-rate-limit',
    category: 'admin-rate-limit',
    description:
      'Shared enterprise admin mutation rate limiting (required adapter; resolves after S06)',
    required: true,
    // Reserved path: integration is a one-line path land when S06 ships.
    testFiles: ['apps/server/src/enterprise/security/rateLimit/adminMutationRateLimit.test.ts'],
  },
] as const;

export const REQUIRED_PEN_ADAPTER_IDS = PEN_REGRESSION_MANIFEST.filter(
  (adapter) => adapter.required,
).map((adapter) => adapter.id);
