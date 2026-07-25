import type { AiProviderModelListItem } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { buildProviderModelList, injectSearchSettings } from './providerModelListPolicy';

const model = (
  partial: Partial<AiProviderModelListItem> & Pick<AiProviderModelListItem, 'id'>,
): AiProviderModelListItem => ({
  enabled: true,
  type: 'chat',
  ...partial,
});

describe('buildProviderModelList (shared policy)', () => {
  it('restores builtin type and normalizes legacy stt → asr', () => {
    const defaults = [model({ id: 'sora-2', type: 'video' })];
    const db = [
      model({ id: 'sora-2', type: 'chat' }),
      model({ id: 'legacy-stt', type: 'stt' as never }),
    ];
    const list = buildProviderModelList('openai', defaults, db);
    expect(list.find((m) => m.id === 'sora-2')?.type).toBe('video');
    expect(list.find((m) => m.id === 'legacy-stt')?.type).toBe('asr');
  });

  it('filters invisible models', () => {
    const defaults = [model({ id: 'hidden', visible: false }), model({ id: 'shown' })];
    const list = buildProviderModelList('openai', defaults, []);
    expect(list.map((m) => m.id)).toEqual(['shown']);
  });

  it('prunes branding residual models not in builtin list', () => {
    const defaults = [model({ id: 'kept' })];
    const db = [model({ id: 'residual' })];
    const list = buildProviderModelList('lobehub', defaults, db, {
      brandingProviderId: 'lobehub',
    });
    expect(list.map((m) => m.id)).toEqual(['kept']);
  });

  it('injects search settings when abilities.search is true', () => {
    const defaults = [
      model({
        abilities: { search: true },
        id: 'gpt-4o',
      }),
    ];
    const list = buildProviderModelList('openai', defaults, []);
    expect(list[0]?.settings).toMatchObject({ searchImpl: 'params' });
  });

  it('filters by enabled and applies pagination', () => {
    const defaults = [
      model({ enabled: true, id: 'a' }),
      model({ enabled: false, id: 'b' }),
      model({ enabled: false, id: 'c' }),
    ];
    const list = buildProviderModelList('openai', defaults, [], {
      enabled: false,
      limit: 1,
      offset: 1,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('c');
  });
});

describe('injectSearchSettings', () => {
  it('removes search fields when abilities.search is false', () => {
    const result = injectSearchSettings('openai', {
      abilities: { search: false },
      id: 'x',
      settings: { searchImpl: 'params', other: 1 },
    });
    expect(result.settings).toEqual({ other: 1 });
  });
});
