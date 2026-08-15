// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  isServiceModelManagedPath,
  mergePolicyEditorDraft,
  preserveForeignPublishedInDraft,
} from './policyEditorOwnership';

describe('policyEditorOwnership', () => {
  it('classifies service-model groups and explicit paths as foreign', () => {
    expect(isServiceModelManagedPath('defaultAgent.config.model')).toBe(true);
    expect(isServiceModelManagedPath('defaultAgent.config.provider')).toBe(true);
    expect(isServiceModelManagedPath('tts.openAI.ttsModel')).toBe(true);
    expect(isServiceModelManagedPath('systemAgent.topic.model')).toBe(true);
    expect(isServiceModelManagedPath('image.defaultModel')).toBe(true);
    expect(isServiceModelManagedPath('general.fontSize')).toBe(false);
    expect(isServiceModelManagedPath('memory.enabled')).toBe(false);
  });

  it('mergePolicyEditorDraft preserves foreign and applies owned (including clear)', () => {
    const current = {
      'defaultAgent.config.model': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 'keep-me',
        visibility: 'visible' as const,
      },
      'general.fontSize': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 14,
        visibility: 'visible' as const,
      },
    };
    const incoming = {
      'defaultAgent.config.model': {
        mode: 'locked' as const,
        schemaVersion: 1,
        value: 'evil',
        visibility: 'hidden' as const,
      },
      'memory.enabled': {
        mode: 'locked' as const,
        schemaVersion: 1,
        value: true,
        visibility: 'hidden' as const,
      },
    };

    const merged = mergePolicyEditorDraft(current, incoming);
    expect(merged['defaultAgent.config.model']).toEqual(current['defaultAgent.config.model']);
    expect(merged['general.fontSize']).toBeUndefined();
    expect(merged['memory.enabled']).toEqual(incoming['memory.enabled']);
  });

  it('preserveForeignPublishedInDraft fills missing foreign only', () => {
    const draft = {
      'general.fontSize': {
        mode: 'locked' as const,
        schemaVersion: 1,
        value: 18,
        visibility: 'hidden' as const,
      },
    };
    const next = preserveForeignPublishedInDraft(draft, [
      {
        mode: 'default',
        path: 'defaultAgent.config.model',
        schemaVersion: 1,
        value: 'from-published',
        visibility: 'visible',
      },
      {
        mode: 'default',
        path: 'general.fontSize',
        schemaVersion: 1,
        value: 12,
        visibility: 'visible',
      },
    ]);
    expect(next['defaultAgent.config.model']?.value).toBe('from-published');
    expect(next['general.fontSize']?.value).toBe(18);
  });
});
