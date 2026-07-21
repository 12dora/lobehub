/**
 * Exact fingerprint allowlist for reviewed synthetic fixture lines only.
 * Path-wide wildcards are forbidden — each entry is path + category + lineDigest.
 *
 * Prefer leakage-baseline.json for bulk known findings; this list is for
 * harness self-fixtures that must remain allowlisted independently of baseline regen.
 */
import { createHash } from 'node:crypto';

import type { BaselineFingerprint } from './leakageBaseline';
import { fingerprintKey } from './leakageBaseline';

/** Precomputed digests of synthetic fixture lines (no secret text stored here). */
const digest = (line: string): string => createHash('sha256').update(line).digest('hex');

/**
 * Exact allowlist fingerprints. Update only with human review when fixture content changes.
 * Digests are of the full line content used by the scanner.
 */
export const LEAKAGE_EXACT_ALLOWLIST: readonly BaselineFingerprint[] = [
  {
    path: 'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
    category: 'credential-assignment',
    lineDigest: digest('password=SyntheticFixtureHunter2Value99'),
  },
  {
    path: 'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
    category: 'connection-string',
    lineDigest: digest('postgres://fixture_admin:SyntheticPass99@fixture.invalid:5432/fixture_db'),
  },
  {
    path: 'scripts/enterprise/security-acceptance/fixtures/synthetic-secret.fixture.txt',
    category: 'pem-private-key',
    lineDigest: digest('-----BEGIN PRIVATE KEY-----'),
  },
  {
    path: 'scripts/enterprise/security-acceptance/fixtures/allowlist-boundary.fixture.txt',
    category: 'credential-assignment',
    lineDigest: digest('token=SyntheticAllowlistTokenValue99'),
  },
  {
    path: 'scripts/enterprise/security-acceptance/fixtures/allowlist-boundary.fixture.txt',
    category: 'token-or-api-key',
    lineDigest: digest('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
  },
] as const;

const ALLOWLIST_INDEX = new Set(LEAKAGE_EXACT_ALLOWLIST.map((entry) => fingerprintKey(entry)));

export const isExactAllowlistedFinding = (finding: BaselineFingerprint): boolean =>
  ALLOWLIST_INDEX.has(fingerprintKey(finding));
