import { describe, expect, it } from 'vitest';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';
import type { ContentModerationSettingsView } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { toDraft } from './draft';
import type { ModerationSettingsDraft } from './draftTypes';
import { validateDraftBase } from './draftValidation';

const view = (patch: Partial<ContentModerationSettingsView> = {}): ContentModerationSettingsView =>
  ({
    ...createDefaultContentModerationConfig(),
    revision: 3,
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedBy: 'admin-1',
    ...patch,
  }) as ContentModerationSettingsView;

const draftOf = (patch: Partial<ContentModerationSettingsView> = {}): ModerationSettingsDraft =>
  toDraft(view(patch));

const keysOf = (
  draft: ModerationSettingsDraft,
  options: { persistedBaseUrl?: string } = {},
): string[] => validateDraftBase(draft, options).map((issue) => issue.key);

describe('validateDraftBase — one rule per field', () => {
  it('accepts the shipped defaults', () => {
    expect(keysOf(draftOf())).toEqual([]);
  });

  it('requires at least one request kind', () => {
    expect(keysOf(draftOf({ requestKinds: [] } as never))).toEqual(['requestKindsRequired']);
  });

  it('holds the sample rate to 0–100', () => {
    expect(keysOf(draftOf({ scope: { ...view().scope, sampleRate: -1 } } as never))).toEqual([
      'sampleRateRange',
    ]);
    expect(keysOf(draftOf({ scope: { ...view().scope, sampleRate: 101 } } as never))).toEqual([
      'sampleRateRange',
    ]);
    expect(keysOf(draftOf({ scope: { ...view().scope, sampleRate: 100 } } as never))).toEqual([]);
  });

  it('names every category whose threshold left 0–1', () => {
    const draft = draftOf();
    draft.config.categories.violence = { ...draft.config.categories.violence, threshold: 1.5 };
    draft.config.categories.privacy = { ...draft.config.categories.privacy, threshold: -0.1 };
    const issues = validateDraftBase(draft);
    expect(issues.map((issue) => issue.key)).toEqual(['thresholdRange', 'thresholdRange']);
    // Reported in MODERATION_CATEGORIES order, not in the order the drafts were edited.
    expect(issues.map((issue) => issue.params?.category)).toEqual(['violence', 'privacy']);
  });

  it('demands a provider and a model for the LLM judge', () => {
    const base = { kind: 'llm_judge', onError: 'allow', retryCount: 1, timeoutMs: 3000 };
    expect(keysOf(draftOf({ classifier: base } as never))).toEqual(['llmJudgeRequired']);
    expect(
      keysOf(draftOf({ classifier: { ...base, llmJudge: { model: 'm', provider: '' } } } as never)),
    ).toEqual(['llmJudgeRequired']);
    expect(
      keysOf(
        draftOf({ classifier: { ...base, llmJudge: { model: 'm', provider: 'p' } } } as never),
      ),
    ).toEqual([]);
  });

  it('checks the Moderations endpoint, its scheme, and the keys that survive the save', () => {
    const api = (patch: Record<string, unknown> = {}) =>
      ({
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl: 'https://api.example.com',
            model: 'omni-moderation-latest',
            ...patch,
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      }) as never;

    expect(keysOf(draftOf(api()), { persistedBaseUrl: 'https://api.example.com' })).toEqual([]);
    expect(
      keysOf(draftOf(api({ model: '' })), { persistedBaseUrl: 'https://api.example.com' }),
    ).toEqual(['moderationsApiRequired']);
    expect(
      keysOf(draftOf(api({ baseUrl: 'ftp://api.example.com' })), {
        persistedBaseUrl: 'ftp://api.example.com',
      }),
    ).toEqual(['moderationsApiUrl']);
    expect(keysOf(draftOf(api({ apiKeys: [] })))).toEqual(['moderationsApiKeyRequired']);
    // Moving the endpoint drops the stored keys, so the count that matters is the post-save one.
    expect(keysOf(draftOf(api()), { persistedBaseUrl: 'https://other.example.com' })).toEqual([
      'moderationsApiKeyRequired',
    ]);
  });

  it('rejects a half-configured downgrade target', () => {
    expect(keysOf(draftOf({ downgrade: { model: '', provider: 'openai' } } as never))).toEqual([
      'downgradeIncomplete',
    ]);
    expect(keysOf(draftOf({ downgrade: { model: 'm', provider: 'openai' } } as never))).toEqual([]);
  });

  it('caps the block message by characters and the downgrade message by encoded bytes', () => {
    const messages = (blockMessage: string, downgradeMessage: string) =>
      ({ messages: { ...view().messages, blockMessage, downgradeMessage } }) as never;

    expect(keysOf(draftOf(messages('x'.repeat(2001), 'ok')))).toEqual(['blockMessageTooLong']);
    expect(keysOf(draftOf(messages('ok', 'x'.repeat(301))))).toEqual(['downgradeMessageTooLong']);
    // 250 CJK characters are inside the 300-character cap but ~2,250 bytes once percent-encoded.
    expect(keysOf(draftOf(messages('ok', '内'.repeat(250))))).toEqual(['downgradeMessageTooHeavy']);
    expect(keysOf(draftOf(messages('ok', '内'.repeat(200))))).toEqual([]);
  });

  it('holds both retention windows', () => {
    const records = (patch: Record<string, unknown>) =>
      ({ records: { ...view().records, ...patch } }) as never;

    expect(
      keysOf(
        draftOf(records({ nonHitRetentionDays: MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS + 1 })),
      ),
    ).toEqual(['nonHitRetention']);
    expect(keysOf(draftOf(records({ hitRetentionDays: 0 })))).toEqual(['hitRetention']);
  });

  it('only checks notification addresses once notifications are on', () => {
    const notify = (patch: Record<string, unknown>) =>
      ({ notify: { ...view().notify, ...patch } }) as never;

    expect(keysOf(draftOf(notify({ emails: ['not-an-email'] })))).toEqual([]);
    expect(keysOf(draftOf(notify({ enabled: true })))).toEqual(['notifyEmailsRequired']);
    expect(keysOf(draftOf(notify({ emails: ['nope', 'ok@example.com'], enabled: true })))).toEqual([
      'notifyEmailInvalid',
    ]);
  });

  it('only checks the auto-ban threshold once auto-ban is on', () => {
    const autoBan = (patch: Record<string, unknown>) =>
      ({ autoBan: { ...view().autoBan, ...patch } }) as never;

    expect(keysOf(draftOf(autoBan({ threshold: 0 })))).toEqual([]);
    expect(keysOf(draftOf(autoBan({ enabled: true, threshold: 0 })))).toEqual(['autoBanThreshold']);
    expect(keysOf(draftOf(autoBan({ enabled: true, threshold: 1 })))).toEqual([]);
  });

  it('reports every broken field, in field order — the form shows the first one', () => {
    const draft = draftOf({
      autoBan: { ...view().autoBan, enabled: true, threshold: 0 },
      downgrade: { model: '', provider: 'openai' },
      notify: { ...view().notify, emails: [], enabled: true },
      records: { ...view().records, hitRetentionDays: 0 },
      requestKinds: [],
      scope: { ...view().scope, sampleRate: 200 },
    } as never);

    expect(keysOf(draft)).toEqual([
      'requestKindsRequired',
      'sampleRateRange',
      'downgradeIncomplete',
      'hitRetention',
      'notifyEmailsRequired',
      'autoBanThreshold',
    ]);
  });
});
