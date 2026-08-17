import { describe, expect, it } from 'vitest';

import {
  INFRA_SETTINGS_ID_MAIL,
  INFRA_SETTINGS_ID_OBJECT_STORAGE,
  INFRA_SETTINGS_IDS,
  INFRA_SETTINGS_INVALIDATION_SCOPE,
  INFRA_SETTINGS_LIMITS,
} from './infraSettings';

describe('infraSettings const', () => {
  it('pins the two row ids and the invalidation scope', () => {
    expect(INFRA_SETTINGS_IDS).toEqual(['object_storage', 'mail']);
    expect(INFRA_SETTINGS_ID_OBJECT_STORAGE).toBe('object_storage');
    expect(INFRA_SETTINGS_ID_MAIL).toBe('mail');
    expect(INFRA_SETTINGS_INVALIDATION_SCOPE).toBe('infra_settings');
    expect(INFRA_SETTINGS_LIMITS.SNAPSHOT_TTL_MS).toBe(30_000);
  });
});
