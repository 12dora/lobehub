import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAdminAgentDraft,
  loadAdminAgentDraft,
  saveAdminAgentDraft,
} from './localDraftStorage';

const value = {
  draft: {
    config: {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Research',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Research carefully.',
      tags: [],
    },
    dependencySnapshot: {
      connectors: [],
      model: {
        modelKey: 'gpt-4.1',
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 1,
      },
      skills: [],
    },
    version: '1.0.1',
  },
  draftToken: 'b'.repeat(64),
  revision: 3,
  savedAt: '2026-07-17T00:00:00.000Z',
};

describe('admin Agent recovery draft storage', () => {
  beforeEach(() => localStorage.clear());

  it('survives reload and clears only the selected Agent', () => {
    saveAdminAgentDraft('agent-1', value);
    expect(loadAdminAgentDraft('agent-1')).toEqual(value);
    clearAdminAgentDraft('agent-1');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });

  it('removes malformed recovery data instead of hydrating it', () => {
    localStorage.setItem('aihub.admin.agents.draft.agent-1', '{bad');
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
    expect(localStorage.getItem('aihub.admin.agents.draft.agent-1')).toBeNull();
  });
});
