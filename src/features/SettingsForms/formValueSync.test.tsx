/**
 * @vitest-environment happy-dom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type SaveStateHandle } from '@/hooks/useSaveState';

import ImageFormView from './ImageFormView';
import MemoryFormView from './MemoryFormView';
import OpenAIFormView from './OpenAIFormView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/enterprise/client/providers/RuntimeBrandingProvider', () => ({
  useBranding: () => ({ name: 'LobeHub' }),
}));

vi.mock('@/features/PlatformSettingSourceBadge/ManagedFormControl', () => ({
  // Forward Form.Item value/onChange (and valuePropName) into the inner control.
  ManagedFormControlContent: ({
    children,
    ...formInjected
  }: {
    children: ReactElement;
  } & Record<string, unknown>) => {
    if (!isValidElement(children)) return children as ReactNode;
    return cloneElement(children, formInjected as never);
  },
}));

vi.mock('@/features/PlatformSettingSourceBadge/ManagedSettingField', () => ({
  ManagedSettingFieldContent: ({
    children,
  }: {
    children: (ctx: { disabled: boolean }) => ReactNode;
  }) => <>{children({ disabled: false })}</>,
}));

vi.mock('@/features/ModelSwitchPanel/components/ControlsForm/LevelSlider', () => ({
  default: ({ value }: { value?: string }) => <div data-testid="effort-slider">{value}</div>,
}));

vi.mock('@/components/FormInput', () => ({
  FormSliderWithInput: (props: { value?: number }) => (
    <div data-testid="image-slider" data-value={String(props.value ?? '')} />
  ),
}));

vi.mock('@/components/Editor/AutoSaveHint', () => ({
  default: () => null,
}));

const toastError = vi.fn();

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({ value }: { value?: string }) => (
    <div data-testid="tts-select">{String(value ?? '')}</div>
  ),
  Switch: ({ checked }: { checked?: boolean }) => (
    <button data-checked={String(Boolean(checked))} data-testid="memory-switch" type="button" />
  ),
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const idleSaveState: Pick<SaveStateHandle, 'lastSavedAt' | 'retry' | 'save' | 'status'> = {
  lastSavedAt: null,
  retry: vi.fn(async () => undefined),
  save: async (fn: () => Promise<void>) => {
    await fn();
  },
  status: 'idle',
};

describe('SettingsForms external value synchronization (CS-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastError.mockClear();
  });

  it('updates the memory enabled Switch when value.enabled changes after mount', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MemoryFormView
        canManage
        isInit
        saveState={idleSaveState}
        value={{ enabled: false, effort: 'medium' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId('effort-slider').textContent).toBe('medium');
    expect(screen.getByTestId('memory-switch')).toHaveAttribute('data-checked', 'false');

    rerender(
      <MemoryFormView
        canManage
        isInit
        saveState={idleSaveState}
        value={{ enabled: true, effort: 'high' }}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('effort-slider').textContent).toBe('high');
      expect(screen.getByTestId('memory-switch')).toHaveAttribute('data-checked', 'true');
    });
  });

  it('propagates value.defaultImageNum into the slider after external rerender', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ImageFormView
        canManage
        isInit
        value={{ defaultImageNum: 1 } as never}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId('image-slider')).toHaveAttribute('data-value', '1');

    await act(async () => {
      rerender(
        <ImageFormView
          canManage
          isInit
          value={{ defaultImageNum: 4 } as never}
          onChange={onChange}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('image-slider')).toHaveAttribute('data-value', '4');
    });
  });

  it('propagates value.openAI.ttsModel into the select after external rerender', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <OpenAIFormView
        canManage
        isInit
        value={{ openAI: { ttsModel: 'tts-1' } }}
        onChange={onChange}
      />,
    );

    expect(screen.getByTestId('tts-select').textContent).toBe('tts-1');

    await act(async () => {
      rerender(
        <OpenAIFormView
          canManage
          isInit
          value={{ openAI: { ttsModel: 'tts-1-hd' } }}
          onChange={onChange}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('tts-select').textContent).toBe('tts-1-hd');
    });
  });
});
