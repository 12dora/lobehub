// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  buildModerationMetadataMergeSql,
  persistModerationDowngradeBestEffort,
  readAssistantMessageId,
  readModerationDowngrade,
  stashModerationDowngrade,
  toMessageModerationMetadata,
} from './agentRuntimeMetadata';
import type { ModerationDowngradeMarker } from './types';

const sqlText = (value: unknown, seen = new WeakSet<object>()): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sqlText(item, seen)).join('');
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(record.queryChunks)) {
    return record.queryChunks.map((item) => sqlText(item, seen)).join('');
  }
  if (typeof record.value === 'string') return record.value;
  if (Array.isArray(record.value)) return record.value.map((item) => sqlText(item, seen)).join('');
  return '';
};

const marker: ModerationDowngradeMarker = {
  action: 'downgrade',
  category: 'jailbreak',
  message: 'Switched to {{model}}',
  model: 'gpt-4o-mini',
  originalModel: 'gpt-4o',
  originalProvider: 'openai',
  provider: 'openai',
  recordId: 'rec-1',
};

describe('agentRuntimeMetadata', () => {
  it('stashes and reads the downgrade marker on chat options', () => {
    const options: Record<string, unknown> = { metadata: { assistantMessageId: 'asst-1' } };
    stashModerationDowngrade(options, marker);
    expect(readModerationDowngrade(options)).toEqual(marker);
    expect(readAssistantMessageId(options)).toBe('asst-1');
  });

  it('maps the marker onto MessageModerationMetadata including message', () => {
    expect(toMessageModerationMetadata(marker)).toEqual({
      action: 'downgrade',
      category: 'jailbreak',
      message: 'Switched to {{model}}',
      model: 'gpt-4o-mini',
      originalModel: 'gpt-4o',
      originalProvider: 'openai',
      provider: 'openai',
      recordId: 'rec-1',
    });
  });

  it('builds an atomic JSONB merge fragment', () => {
    const fragment = buildModerationMetadataMergeSql(marker);
    const text = sqlText(fragment);
    expect(text.toLowerCase()).toContain('coalesce');
    expect(text).toContain('||');
    expect(text).toContain('jsonb');
  });

  it('persists via a single UPDATE with JSONB || merge (not MessageModel read-merge-write)', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    let captured: { metadata: unknown; model?: string; provider?: string } | undefined;
    const set = vi.fn((values: { metadata: unknown; model?: string; provider?: string }) => {
      captured = values;
      return { where };
    });
    const update = vi.fn(() => ({ set }));
    const db = { update } as never;

    await persistModerationDowngradeBestEffort({
      db,
      marker,
      messageId: 'asst-1',
      userId: 'user-1',
    });

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    expect(captured?.model).toBe('gpt-4o-mini');
    expect(captured?.provider).toBe('openai');
    const text = sqlText(captured?.metadata);
    expect(text.toLowerCase()).toContain('coalesce');
    expect(text).toContain('jsonb');
    expect(where).toHaveBeenCalledOnce();
  });

  it('swallows persist failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      persistModerationDowngradeBestEffort({
        db: {
          update: () => {
            throw new Error('db down sk-abc leaked');
          },
        } as never,
        marker,
        messageId: 'asst-1',
        userId: 'user-1',
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[content-moderation] failed to persist downgrade metadata',
      { code: 'moderation_internal', errorClass: 'Error' },
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('sk-abc');
    error.mockRestore();
  });
});
