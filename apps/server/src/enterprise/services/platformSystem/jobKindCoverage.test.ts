// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_JOB_LEDGER_TYPES } from '@/database/schemas/platform';
import { adminSystemJobKindSchema } from '@/server/enterprise/contracts/adminSystem';

import { PLATFORM_AGENT_ROLLOUT_JOB_TYPE } from '../agentCatalog/rolloutService';
import { SHARED_OAUTH_KEEPALIVE_JOB_TYPE } from '../aiCatalog/sharedOAuthKeepalive';
import { SHARED_OAUTH_REFRESH_JOB_TYPE } from '../aiCatalog/sharedOAuthRefresh';
import { PLATFORM_AUDIT_EXPORT_JOB_TYPE } from '../audit/exportConstants';
import { PLATFORM_AUDIT_RETENTION_JOB_TYPE } from '../audit/retentionConstants';
import { OAUTH_REFRESH_JOB_TYPE } from '../connectorCatalog/connectorOAuthRefreshCoordinator';
import { CONNECTOR_RUNTIME_JOB_TYPE } from '../connectorCatalog/runtimeExecutionJournal';
import { CONNECTOR_SECRET_CLEANUP_JOB_TYPE } from '../connectorCatalog/secretCleanup';
import { PLATFORM_SECRET_REWRAP_JOB_TYPE } from '../secretRewrap/contracts';
import { JOB_KIND_BY_TYPE, jobKind } from './adminService';

/**
 * Every queue an operator can see in 近期任务, taken from the producing module's own constant so a
 * renamed queue type breaks this test instead of silently degrading the page to 其他后台任务.
 */
const OPERATOR_VISIBLE_JOB_TYPES = [
  CONNECTOR_RUNTIME_JOB_TYPE,
  CONNECTOR_SECRET_CLEANUP_JOB_TYPE,
  OAUTH_REFRESH_JOB_TYPE,
  PLATFORM_AGENT_ROLLOUT_JOB_TYPE,
  PLATFORM_AUDIT_EXPORT_JOB_TYPE,
  PLATFORM_AUDIT_RETENTION_JOB_TYPE,
  PLATFORM_SECRET_REWRAP_JOB_TYPE,
  SHARED_OAUTH_KEEPALIVE_JOB_TYPE,
  SHARED_OAUTH_REFRESH_JOB_TYPE,
];

describe('admin system job kind coverage', () => {
  it('labels every queue type an operator can see', () => {
    const unlabelled = OPERATOR_VISIBLE_JOB_TYPES.filter((type) => jobKind(type) === 'unknown');

    expect(
      unlabelled,
      `register these job types in JOB_KIND_BY_TYPE (adminService.ts):\n${unlabelled.join('\n')}`,
    ).toEqual([]);
    expect(Object.keys(JOB_KIND_BY_TYPE).sort()).toEqual([...OPERATOR_VISIBLE_JOB_TYPES].sort());
  });

  it('keeps every mapped kind inside the published enum and never maps to unknown', () => {
    const options = new Set<string>(adminSystemJobKindSchema.options);
    const kinds = Object.values(JOB_KIND_BY_TYPE);

    expect(kinds.filter((kind) => !options.has(kind))).toEqual([]);
    expect(kinds).not.toContain('unknown');
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(options.has('unknown')).toBe(true);
  });

  it('falls back to unknown for ledger and unregistered types', () => {
    for (const type of PLATFORM_JOB_LEDGER_TYPES) expect(jobKind(type)).toBe('unknown');
    expect(jobKind('future.platform.job.v1')).toBe('unknown');
  });

  it('never labels a queue that would become cancellable or retryable', () => {
    const mutable = Object.values(JOB_KIND_BY_TYPE).filter(
      (kind) => kind === 'agent_rollout' || kind === 'secret_rewrap',
    );

    expect(mutable.sort()).toEqual(['agent_rollout', 'secret_rewrap']);
  });
});
