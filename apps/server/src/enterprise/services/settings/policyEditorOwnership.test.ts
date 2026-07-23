// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  isServiceModelManagedPath,
  mergePolicyEditorDraft,
  overlayCurrentForeignPolicies,
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

  it('overlayCurrentForeignPolicies restores owned history but keeps current foreign', () => {
    const historical = {
      'general.fontSize': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 14,
        visibility: 'visible' as const,
      },
      'image.defaultImageNum': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 2,
        visibility: 'visible' as const,
      },
    };
    const currentPublished = [
      {
        mode: 'locked',
        path: 'image.defaultImageNum',
        schemaVersion: 1,
        value: 8,
        visibility: 'hidden',
      },
      {
        mode: 'default',
        path: 'image.defaultImageSize',
        schemaVersion: 1,
        value: '1024x1024',
        visibility: 'visible',
      },
    ];

    const next = overlayCurrentForeignPolicies(historical, currentPublished);
    expect(next['general.fontSize']?.value).toBe(14);
    // Stale historical foreign value must not win over newer service-model state.
    expect(next['image.defaultImageNum']).toEqual({
      mode: 'locked',
      schemaVersion: 1,
      value: 8,
      visibility: 'hidden',
    });
    // Foreign rows added after the target revision stay present.
    expect(next['image.defaultImageSize']?.value).toBe('1024x1024');
  });
});
