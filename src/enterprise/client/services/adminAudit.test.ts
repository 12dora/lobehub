import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminAuditService } from './adminAudit';

const query = vi.fn();
const mutate = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      audit: {
        conversations: {
          get: { query: (...args: unknown[]) => query('conversations.get', ...args) },
          list: { query: (...args: unknown[]) => query('conversations.list', ...args) },
          messages: { query: (...args: unknown[]) => query('conversations.messages', ...args) },
        },
        events: {
          facets: { query: (...args: unknown[]) => query('events.facets', ...args) },
          get: { query: (...args: unknown[]) => query('events.get', ...args) },
          list: { query: (...args: unknown[]) => query('events.list', ...args) },
          stats: { query: (...args: unknown[]) => query('events.stats', ...args) },
        },
        exports: {
          cancel: { mutate: (...args: unknown[]) => mutate('exports.cancel', ...args) },
          create: { mutate: (...args: unknown[]) => mutate('exports.create', ...args) },
          download: { mutate: (...args: unknown[]) => mutate('exports.download', ...args) },
          get: { query: (...args: unknown[]) => query('exports.get', ...args) },
          list: { query: (...args: unknown[]) => query('exports.list', ...args) },
        },
        legalHolds: {
          create: { mutate: (...args: unknown[]) => mutate('legalHolds.create', ...args) },
          get: { query: (...args: unknown[]) => query('legalHolds.get', ...args) },
          list: { query: (...args: unknown[]) => query('legalHolds.list', ...args) },
          release: { mutate: (...args: unknown[]) => mutate('legalHolds.release', ...args) },
        },
        policy: {
          get: { query: (...args: unknown[]) => query('policy.get', ...args) },
          update: { mutate: (...args: unknown[]) => mutate('policy.update', ...args) },
        },
        retention: {
          cancel: { mutate: (...args: unknown[]) => mutate('retention.cancel', ...args) },
          dryRun: { mutate: (...args: unknown[]) => mutate('retention.dryRun', ...args) },
          getRun: { query: (...args: unknown[]) => query('retention.getRun', ...args) },
          listRuns: { query: (...args: unknown[]) => query('retention.listRuns', ...args) },
          run: { mutate: (...args: unknown[]) => mutate('retention.run', ...args) },
          status: { query: (...args: unknown[]) => query('retention.status', ...args) },
        },
        users: {
          search: { query: (...args: unknown[]) => query('users.search', ...args) },
          summary: { query: (...args: unknown[]) => query('users.summary', ...args) },
          timeline: { query: (...args: unknown[]) => query('users.timeline', ...args) },
        },
      },
    },
  },
}));

describe('adminAuditService', () => {
  beforeEach(() => {
    query.mockReset();
    mutate.mockReset();
    query.mockResolvedValue({ ok: true });
    mutate.mockResolvedValue({ ok: true });
  });

  it('forwards events.list filters without rewriting them', async () => {
    const input = {
      actions: ['admin.users.ban'],
      from: new Date('2026-01-01T00:00:00.000Z'),
      limit: 20,
      results: ['success' as const],
      to: new Date('2026-01-08T00:00:00.000Z'),
    };
    await adminAuditService.listEvents(input);
    expect(query).toHaveBeenCalledWith('events.list', input);
  });

  it('forwards export download mutation with reason', async () => {
    await adminAuditService.downloadExport({ id: 'e1', reason: 'legal review' });
    expect(mutate).toHaveBeenCalledWith('exports.download', {
      id: 'e1',
      reason: 'legal review',
    });
  });

  it('forwards retention dryRun scope all', async () => {
    await adminAuditService.retentionDryRun({ reason: 'preview', scope: 'all' });
    expect(mutate).toHaveBeenCalledWith('retention.dryRun', {
      reason: 'preview',
      scope: 'all',
    });
  });

  it('forwards policy.update with expectedRevision', async () => {
    await adminAuditService.updatePolicy({
      expectedRevision: 3,
      maxListWindowDays: 30,
      reason: 'tighten window',
    });
    expect(mutate).toHaveBeenCalledWith('policy.update', {
      expectedRevision: 3,
      maxListWindowDays: 30,
      reason: 'tighten window',
    });
  });
});
