// @vitest-environment happy-dom
import type { EffortLevel } from '@lobechat/model-runtime';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import settingCopy from '@/locales/default/setting';

import EffortSelect from './EffortSelect';

/**
 * Resolves against the REAL `setting` dictionary rather than echoing keys, so a lost or
 * misspelled namespace surfaces as "raw key vs real copy" instead of passing silently.
 */
vi.mock('react-i18next', async () => {
  const setting = (await import('@/locales/default/setting')).default as Record<string, string>;

  return {
    useTranslation: () => ({ t: (key: string) => setting[key] ?? key }),
  };
});

vi.mock('@lobehub/ui', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    disabled,
    onChange,
    options,
    value,
  }: {
    disabled?: boolean;
    onChange?: (value: string) => void;
    options?: { label: ReactNode; value: string }[];
    value?: string;
  }) => (
    <select disabled={disabled} value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {String(option.label)}
        </option>
      ))}
    </select>
  ),
}));

const extendParamsMock = vi.fn<() => string[] | undefined>();

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: { modelExtendParams: () => () => extendParamsMock() },
  useScopedAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
}));

const renderSelect = (props: Partial<Parameters<typeof EffortSelect>[0]> = {}) => {
  const onChange = vi.fn();
  render(<EffortSelect model="gpt-5.6" provider="openai" onChange={onChange} {...props} />);
  return { onChange };
};

const picker = () => screen.getByRole('combobox');

/**
 * The copy a level must render as, read from the same source the component translates
 * through — so a missing key shows up as the raw key here too.
 */
const label = (level: EffortLevel) => settingCopy[`serviceModel.reasoningEffort.options.${level}`];

describe('EffortSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the model exposes no discrete effort control', () => {
    extendParamsMock.mockReturnValue(['enableReasoning', 'reasoningBudgetToken']);
    renderSelect();

    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('renders nothing when the model has no extend params at all', () => {
    extendParamsMock.mockReturnValue(undefined);
    renderSelect();

    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('offers a leading default option plus exactly the levels the control declares', () => {
    // grok4_5ReasoningEffort → low | medium | high
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect();

    expect([...picker().querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      settingCopy['serviceModel.reasoningEffort.default'],
      label('low'),
      label('medium'),
      label('high'),
    ]);
  });

  it('shows the default option when no level is stored', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect();

    expect((picker() as HTMLSelectElement).value).toBe('__provider_default__');
  });

  it('displays a stored null clear exactly like an absent level', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ value: null });

    expect((picker() as HTMLSelectElement).value).toBe('__provider_default__');
  });

  it('shows the stored level when it is offered', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ value: 'medium' });

    expect((picker() as HTMLSelectElement).value).toBe('medium');
  });

  it('clamps a stored level the current model no longer offers to the control default', () => {
    // `max` is not one of grok4_5's levels; its default is `high`.
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ value: 'max' });

    expect((picker() as HTMLSelectElement).value).toBe('high');
  });

  it('emits the level and the registry configKey on selection', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    const { onChange } = renderSelect();

    fireEvent.change(picker(), { target: { value: 'low' } });

    expect(onChange).toHaveBeenCalledWith('low', 'grok4_5ReasoningEffort');
  });

  it('emits undefined when the default option is chosen', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    const { onChange } = renderSelect({ value: 'low' });

    fireEvent.change(picker(), { target: { value: '__provider_default__' } });

    expect(onChange).toHaveBeenCalledWith(undefined, 'grok4_5ReasoningEffort');
  });

  it('reads the default-assistant level out of chatConfig under the control configKey', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ chatConfig: { grok4_5ReasoningEffort: 'low' } as never });

    expect((picker() as HTMLSelectElement).value).toBe('low');
  });

  it('offers no Default option in chatConfig mode, where a clear cannot persist', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ chatConfig: {} as never });

    expect([...picker().querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      label('low'),
      label('medium'),
      label('high'),
    ]);
  });

  it('seeds an unset chatConfig with the control default instead of a Default option', () => {
    // grok4_5ReasoningEffort defaults to `high`.
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ chatConfig: {} as never });

    expect((picker() as HTMLSelectElement).value).toBe('high');
  });

  it('seeds an unset gpt-5.5 chatConfig with medium, not the registry static default', () => {
    // gpt5_2ReasoningEffort's static default is `none`, but gpt-5.5 overrides it to `medium`.
    // Duplicating only the thinkingLevel override here would have shown `none` and disagreed
    // with the in-chat selector for the same model.
    extendParamsMock.mockReturnValue(['gpt5_2ReasoningEffort']);
    renderSelect({ chatConfig: {} as never, model: 'gpt-5.5' });

    expect((picker() as HTMLSelectElement).value).toBe('medium');
  });

  it('keeps the registry static default for a model the override does not apply to', () => {
    extendParamsMock.mockReturnValue(['gpt5_2ReasoningEffort']);
    renderSelect({ chatConfig: {} as never, model: 'gpt-5.2' });

    expect((picker() as HTMLSelectElement).value).toBe('none');
  });

  it('seeds an unset chatConfig with the model-specific thinkingLevel default', () => {
    // `gemini-flash-latest` overrides the static `high` default down to `medium`.
    extendParamsMock.mockReturnValue(['thinkingLevel']);
    renderSelect({ chatConfig: {} as never, model: 'gemini-flash-latest' });

    expect((picker() as HTMLSelectElement).value).toBe('medium');
  });

  it('keeps the Default option in systemAgent mode', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect();

    expect([...picker().querySelectorAll('option')].map((option) => option.textContent)).toContain(
      settingCopy['serviceModel.reasoningEffort.default'],
    );
  });

  it('renders the real localized copy, not a key and not the raw level', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ chatConfig: {} as never });

    expect([...picker().querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Low',
      'Medium',
      'High',
    ]);
  });

  it('localizes option labels while keeping raw levels as the persisted values', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    const { onChange } = renderSelect({ chatConfig: {} as never });

    expect([...picker().querySelectorAll('option')].map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
    ]);

    fireEvent.change(picker(), { target: { value: 'low' } });

    expect(onChange).toHaveBeenCalledWith('low', 'grok4_5ReasoningEffort');
  });

  it('is disabled when the managed cluster is disabled', () => {
    extendParamsMock.mockReturnValue(['grok4_5ReasoningEffort']);
    renderSelect({ disabled: true });

    expect(picker()).toBeDisabled();
  });
});
