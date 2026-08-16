import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildCreateSkillInput,
  type CreateSkillFormAction,
  createSkillFormReducer,
  type CreateSkillFormStringField,
  initialCreateSkillFormState,
} from './useCreateSkillForm';

describe('useCreateSkillForm reducer', () => {
  it('builds a trimmed create payload and rejects incomplete forms', () => {
    const base = initialCreateSkillFormState();
    expect(buildCreateSkillInput(base)).toEqual({ error: 'required' });

    const ready = createSkillFormReducer(
      createSkillFormReducer(base, {
        field: 'skillKey',
        type: 'setField',
        value: '  demo.skill  ',
      }),
      { field: 'displayName', type: 'setField', value: ' Demo ' },
    );
    expect(buildCreateSkillInput(ready)).toEqual({
      allowBuiltinOverride: false,
      description: null,
      displayName: 'Demo',
      distribution: 'default',
      enabled: true,
      skillKey: 'demo.skill',
    });
  });

  it('tracks submission lifecycle without dropping field values', () => {
    let state = initialCreateSkillFormState();
    state = createSkillFormReducer(state, {
      field: 'skillKey',
      type: 'setField',
      value: 'demo.skill',
    });
    state = createSkillFormReducer(state, { type: 'submitStart' });
    expect(state).toMatchObject({ error: null, loading: true, skillKey: 'demo.skill' });
    state = createSkillFormReducer(state, { error: 'boom', type: 'submitError' });
    expect(state).toMatchObject({ error: 'boom', loading: false, skillKey: 'demo.skill' });
    state = createSkillFormReducer(state, { type: 'setAllowBuiltinOverride', value: true });
    state = createSkillFormReducer(state, { type: 'setDistribution', value: 'mandatory' });
    state = createSkillFormReducer(state, { type: 'setEnabled', value: false });
    expect(state).toMatchObject({
      allowBuiltinOverride: true,
      distribution: 'mandatory',
      enabled: false,
    });
  });

  it('types setField as string fields only (compile-time regression)', () => {
    expectTypeOf<CreateSkillFormStringField>().toEqualTypeOf<
      'description' | 'displayName' | 'skillKey'
    >();
    // Non-string identity fields are excluded from setField and use dedicated actions.
    expectTypeOf<'enabled'>().not.toMatchTypeOf<CreateSkillFormStringField>();
    expectTypeOf<'distribution'>().not.toMatchTypeOf<CreateSkillFormStringField>();
    expectTypeOf<'allowBuiltinOverride'>().not.toMatchTypeOf<CreateSkillFormStringField>();

    const stringFieldAction = {
      field: 'skillKey',
      type: 'setField',
      value: 'ok',
    } as const satisfies CreateSkillFormAction;

    expect(createSkillFormReducer(initialCreateSkillFormState(), stringFieldAction).skillKey).toBe(
      'ok',
    );

    const enabledAction = {
      type: 'setEnabled',
      value: false,
    } as const satisfies CreateSkillFormAction;
    const distributionAction = {
      type: 'setDistribution',
      value: 'default',
    } as const satisfies CreateSkillFormAction;

    expect(createSkillFormReducer(initialCreateSkillFormState(), enabledAction).enabled).toBe(
      false,
    );
    expect(
      createSkillFormReducer(initialCreateSkillFormState(), distributionAction).distribution,
    ).toBe('default');
  });
});
