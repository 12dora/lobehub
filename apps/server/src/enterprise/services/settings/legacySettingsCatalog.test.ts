// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { validateLegacySettingsUpdate } from './legacySettingsCatalog';

describe('strict legacy settings catalog (B4-R2)', () => {
  it('accepts sparse valid defaultAgent leaves', () => {
    const r = validateLegacySettingsUpdate({
      defaultAgent: {
        config: { model: 'gpt-4o-mini', provider: 'openai', params: { temperature: 0.7 } },
        meta: { title: 'A' },
      },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown nested defaultAgent.config field with zero-write semantics', () => {
    const r = validateLegacySettingsUpdate({
      defaultAgent: {
        config: { model: 'x', unknownNested: true },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toMatch(/UNKNOWN|INVALID/);
    }
  });

  it('rejects secret-like nested general.apiKey', () => {
    const r = validateLegacySettingsUpdate({
      general: { fontSize: 14, apiKey: 'sk-x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MANAGED_SETTING_SECRET_PATH');
    }
  });

  it('rejects unexpected top-level languageModel', () => {
    const r = validateLegacySettingsUpdate({
      languageModel: { openai: {} },
    });
    expect(r.ok).toBe(false);
  });
});
