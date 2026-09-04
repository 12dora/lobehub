import { describe, expect, it, vi } from 'vitest';

import {
  reloadTaskTemplate,
  TASK_TEMPLATE_RECOVERY_SCAN_LIMIT,
  type TaskTemplateListReader,
} from './reloadTaskTemplate';
import type { AdminTaskTemplateItem } from './types';

const i18nState = vi.hoisted(() => ({
  language: 'en',
  resolvedLanguage: 'zh-CN' as string | undefined,
}));

vi.mock('i18next', () => ({ default: i18nState }));

const row = (overrides: Partial<AdminTaskTemplateItem> = {}): AdminTaskTemplateItem =>
  ({
    category: 'engineering',
    connectors: [],
    cronPattern: '0 9 * * *',
    description: 'Daily digest',
    enabled: true,
    icon: null,
    id: 'tpl-1',
    identifier: 'daily-digest',
    instruction: 'Summarize',
    interests: [],
    revision: 3,
    sortOrder: 0,
    source: 'manual',
    title: 'Engineering digest',
    updatedAt: new Date('2026-08-16T00:00:00Z'),
    ...overrides,
  }) as AdminTaskTemplateItem;

const reader = (output: unknown): TaskTemplateListReader =>
  vi.fn().mockResolvedValue(output) as unknown as TaskTemplateListReader;

describe('reloadTaskTemplate', () => {
  it('searches by the immutable identifier, unfiltered by enabled, up to the contract ceiling', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], totalAll: 0, totalFiltered: 0 });
    await reloadTaskTemplate(row(), list as unknown as TaskTemplateListReader);

    expect(list).toHaveBeenCalledWith({
      limit: TASK_TEMPLATE_RECOVERY_SCAN_LIMIT,
      locale: 'zh-CN',
      offset: 0,
      query: 'daily-digest',
    });
    // No `enabled` filter: the winning write may have hidden the row, and it must still reload.
    expect(list.mock.calls[0]![0]).not.toHaveProperty('enabled');
  });

  it('returns the current server row when the search still contains it', async () => {
    const fresh = row({ revision: 9, title: 'Renamed by someone else' });
    const result = await reloadTaskTemplate(
      row(),
      reader({ items: [fresh], totalAll: 1, totalFiltered: 1 }),
    );

    expect(result).toEqual({ item: fresh, status: 'found' });
  });

  it('matches on id, never on the position in the result set', async () => {
    // The identifier search is an ILIKE-contains, so neighbours can share the prefix.
    const fresh = row({ revision: 9 });
    const neighbour = row({ id: 'tpl-2', identifier: 'daily-digest-weekly', revision: 1 });
    const result = await reloadTaskTemplate(
      row(),
      reader({ items: [neighbour, fresh], totalAll: 2, totalFiltered: 2 }),
    );

    expect(result).toEqual({ item: fresh, status: 'found' });
  });

  it('reports a deletion only when the untruncated search proves the row is gone', async () => {
    const result = await reloadTaskTemplate(
      row(),
      reader({ items: [row({ id: 'tpl-2' })], totalAll: 1, totalFiltered: 1 }),
    );

    expect(result).toEqual({ status: 'deleted' });
  });

  it('refuses to claim a deletion when the read was truncated', async () => {
    // The row may simply sit past the scanned window; guessing "deleted" would tell the operator
    // to throw an unsaved draft away.
    const result = await reloadTaskTemplate(
      row(),
      reader({ items: [row({ id: 'tpl-2' })], totalAll: 400, totalFiltered: 300 }),
    );

    expect(result).toEqual({ status: 'unverified' });
  });

  it('reports a failed read as unverified rather than propagating or claiming a deletion', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await reloadTaskTemplate(row(), list as unknown as TaskTemplateListReader);

    expect(result).toEqual({ status: 'unverified' });
  });
});
