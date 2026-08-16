import { describe, expect, it } from 'vitest';

import { TASK_TEMPLATE_MAX_CONNECTORS } from '@/server/enterprise/contracts/adminTaskTemplates';

import { buildConnectorOptions, isKnownConnector } from './connectorCatalog';
import type { AdminTaskTemplateItem } from './types';
import { createTaskTemplateFormState, validateTaskTemplateForm } from './useTaskTemplateForm';

const messages = {
  connectorLimit: 'limit',
  connectorRetired: 'retired',
  connectors: 'pick-one',
  cron: 'bad-cron',
  instruction: 'need-instruction',
  title: 'need-title',
};

const validState = () => ({
  ...createTaskTemplateFormState(),
  instruction: 'Summarize yesterday.',
  title: 'Engineering digest',
});

const connector = (identifier: string, source: 'composio' | 'lobehub' = 'lobehub') => ({
  identifier,
  required: true,
  source,
});

describe('validateTaskTemplateForm', () => {
  it('accepts a minimal valid template', () => {
    expect(validateTaskTemplateForm(validState(), messages)).toEqual({});
  });

  it('requires a title, an instruction and a supported cron', () => {
    const errors = validateTaskTemplateForm(
      {
        ...createTaskTemplateFormState(),
        schedule: {
          ...createTaskTemplateFormState().schedule,
          pattern: '0 9 1 * *',
          preset: 'custom',
        },
      },
      messages,
    );
    expect(errors).toEqual({
      cron: 'bad-cron',
      instruction: 'need-instruction',
      title: 'need-title',
    });
  });

  it('asks the operator to finish an unpicked connector row', () => {
    const errors = validateTaskTemplateForm(
      { ...validState(), connectors: [connector('')] },
      messages,
    );
    expect(errors.connectors).toBe('pick-one');
  });

  it('blocks saving while a since-retired connector is still referenced', () => {
    const errors = validateTaskTemplateForm(
      { ...validState(), connectors: [connector('retired-provider')] },
      messages,
    );
    // Distinct from the "unfinished row" message: the operator must replace or remove it.
    expect(errors.connectors).toBe('retired');
  });

  it('enforces the API contract connector limit locally', () => {
    const tooMany = Array.from({ length: TASK_TEMPLATE_MAX_CONNECTORS + 1 }, () =>
      connector('github'),
    );
    expect(
      validateTaskTemplateForm({ ...validState(), connectors: tooMany }, messages).connectors,
    ).toBe('limit');

    const atLimit = Array.from({ length: TASK_TEMPLATE_MAX_CONNECTORS }, () => connector('github'));
    expect(
      validateTaskTemplateForm({ ...validState(), connectors: atLimit }, messages).connectors,
    ).toBeUndefined();
  });
});

describe('buildConnectorOptions', () => {
  const retiredLabel = (identifier: string) => `${identifier} (gone)`;

  it('offers the current catalog for a known or empty selection', () => {
    const base = buildConnectorOptions(undefined, retiredLabel);
    expect(base.length).toBeGreaterThan(0);
    expect(buildConnectorOptions(connector('github'), retiredLabel)).toEqual(base);
  });

  it('prepends the stored value when its provider no longer exists', () => {
    const options = buildConnectorOptions(connector('retired-provider'), retiredLabel);
    // Without this the Select would render blank and the operator could not tell what to replace.
    expect(options[0]).toEqual({
      label: 'retired-provider (gone)',
      value: 'lobehub:retired-provider',
    });
    expect(isKnownConnector(connector('retired-provider'))).toBe(false);
  });
});

describe('createTaskTemplateFormState', () => {
  it('carries a stored retired connector into the editor instead of dropping it', () => {
    const item = {
      category: 'engineering',
      connectors: [connector('retired-provider')],
      cronPattern: '0 9 * * *',
      description: '',
      enabled: true,
      icon: null,
      id: 'tpl-1',
      identifier: 'legacy',
      instruction: 'Do the thing.',
      interests: [],
      revision: 4,
      sortOrder: 0,
      source: 'manual',
      title: 'Legacy',
      updatedAt: new Date(),
    } as AdminTaskTemplateItem;

    expect(createTaskTemplateFormState(item).connectors).toEqual([connector('retired-provider')]);
  });
});
