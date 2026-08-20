import { describe, expect, it } from 'vitest';

import {
  AGENT_TEMPLATE_MAX_TAGS,
  AGENT_TEMPLATE_TAG_MAX,
} from '@/server/enterprise/contracts/adminAgentTemplates';

import type { AdminAgentTemplateItem } from './types';
import {
  createAgentTemplateFormState,
  toAgentTemplatePayload,
  validateAgentTemplateForm,
} from './useAgentTemplateForm';

const messages = {
  systemRole: 'need-prompt',
  tagLength: 'tag-too-long',
  tags: 'too-many-tags',
  title: 'need-title',
};

const validState = () => ({
  ...createAgentTemplateFormState(),
  systemRole: 'You are a data analyst.',
  title: 'Data analyst',
});

const item = (overrides: Partial<AdminAgentTemplateItem> = {}): AdminAgentTemplateItem =>
  ({
    avatar: '📊',
    backgroundColor: '#123456',
    description: 'Turns raw numbers into a weekly brief',
    enabled: false,
    id: 'tpl-1',
    identifier: 'data-analyst',
    revision: 4,
    sortOrder: 2,
    source: 'manual',
    systemRole: 'You are a data analyst.',
    tags: ['analytics'],
    title: 'Data analyst',
    updatedAt: new Date('2026-08-16T00:00:00Z'),
    ...overrides,
  }) as AdminAgentTemplateItem;

describe('validateAgentTemplateForm', () => {
  it('accepts a minimal valid template', () => {
    expect(validateAgentTemplateForm(validState(), messages)).toEqual({});
  });

  it('requires a title and a prompt', () => {
    expect(validateAgentTemplateForm(createAgentTemplateFormState(), messages)).toEqual({
      systemRole: 'need-prompt',
      title: 'need-title',
    });
  });

  it('treats whitespace-only values as missing', () => {
    // The server trims before validating, so a form that accepted "   " would fail on save.
    expect(
      validateAgentTemplateForm({ ...validState(), systemRole: '   ', title: '  ' }, messages),
    ).toEqual({ systemRole: 'need-prompt', title: 'need-title' });
  });

  it('enforces the API contract tag limit locally', () => {
    const tooMany = Array.from({ length: AGENT_TEMPLATE_MAX_TAGS + 1 }, (_, i) => `tag-${i}`);
    expect(validateAgentTemplateForm({ ...validState(), tags: tooMany }, messages).tags).toBe(
      'too-many-tags',
    );

    const atLimit = Array.from({ length: AGENT_TEMPLATE_MAX_TAGS }, (_, i) => `tag-${i}`);
    expect(
      validateAgentTemplateForm({ ...validState(), tags: atLimit }, messages).tags,
    ).toBeUndefined();
  });

  it('rejects a tag longer than the contract allows with its own message', () => {
    const long = 'x'.repeat(AGENT_TEMPLATE_TAG_MAX + 1);
    expect(validateAgentTemplateForm({ ...validState(), tags: [long] }, messages).tags).toBe(
      'tag-too-long',
    );
  });

  it('ignores blank tags when counting against the limit', () => {
    // The tag input emits empty entries while typing; they are dropped on submit, so they must
    // not make an otherwise-legal template unsavable.
    const tags = [...Array.from({ length: AGENT_TEMPLATE_MAX_TAGS }, (_, i) => `tag-${i}`), '  '];
    expect(validateAgentTemplateForm({ ...validState(), tags }, messages).tags).toBeUndefined();
  });
});

describe('createAgentTemplateFormState', () => {
  it('starts a new template enabled and empty', () => {
    expect(createAgentTemplateFormState()).toEqual({
      avatar: null,
      backgroundColor: null,
      description: '',
      enabled: true,
      systemRole: '',
      tags: [],
      title: '',
    });
  });

  it('carries every stored field into the editor, including a disabled row', () => {
    expect(createAgentTemplateFormState(item())).toEqual({
      avatar: '📊',
      backgroundColor: '#123456',
      description: 'Turns raw numbers into a weekly brief',
      enabled: false,
      systemRole: 'You are a data analyst.',
      tags: ['analytics'],
      title: 'Data analyst',
    });
  });

  it('copies the tag array instead of aliasing the stored row', () => {
    const row = item();
    const state = createAgentTemplateFormState(row);
    state.tags.push('mutated');
    expect(row.tags).toEqual(['analytics']);
  });
});

describe('toAgentTemplatePayload', () => {
  it('trims text and drops blank tags', () => {
    expect(
      toAgentTemplatePayload({
        avatar: '📊',
        backgroundColor: null,
        description: '  brief  ',
        enabled: true,
        systemRole: '  You are a data analyst.  ',
        tags: [' analytics ', '  ', 'ops'],
        title: '  Data analyst  ',
      }),
    ).toEqual({
      avatar: '📊',
      backgroundColor: null,
      description: 'brief',
      enabled: true,
      systemRole: 'You are a data analyst.',
      tags: ['analytics', 'ops'],
      title: 'Data analyst',
    });
  });
});
