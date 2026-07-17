import type { PlatformEffectiveAgent } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { getPlatformAgentPresentation } from './presentation';

const agent = (distribution: PlatformEffectiveAgent['distribution']): PlatformEffectiveAgent => ({
  agentKey: 'research',
  checksum: 'a'.repeat(64),
  config: {
    avatar: null,
    backgroundColor: null,
    description: null,
    displayName: 'Research',
    modelParameters: {},
    openingMessage: null,
    openingQuestions: [],
    systemRole: 'Research',
    tags: [],
  },
  distribution,
  mutable: false,
  platformAgentId: 'agent-1',
  source: 'platform',
  systemKey: null,
  version: '1.0.0',
  versionId: 'version-1',
});

describe('platform Agent presentation', () => {
  it('locks mandatory Agents and all managed fields', () => {
    expect(getPlatformAgentPresentation(agent('mandatory'), false)).toEqual({
      canHide: false,
      hideFeedback: 'locked',
      managedFieldsEditable: false,
      source: 'organization',
    });
  });

  it('surfaces optional hide feedback without making managed fields editable', () => {
    expect(getPlatformAgentPresentation(agent('optional'), true)).toEqual({
      canHide: true,
      hideFeedback: 'hidden',
      managedFieldsEditable: false,
      source: 'organization',
    });
  });
});
