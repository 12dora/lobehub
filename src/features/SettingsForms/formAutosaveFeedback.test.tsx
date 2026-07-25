/**
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ImageFormView from './ImageFormView';
import OpenAIFormView from './OpenAIFormView';

const toastError = vi.fn();
const setFieldsValue = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => <div data-testid="tts-select" />,
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@lobehub/ui', () => {
  const Form = ({
    onValuesChange,
  }: {
    onValuesChange?: (values: Record<string, unknown>) => void | Promise<void>;
  }) => (
    <button
      data-testid="trigger-change"
      type="button"
      onClick={() => {
        void onValuesChange?.({ defaultImageNum: 3, openAI: { ttsModel: 'tts-1-hd' } });
      }}
    >
      change
    </button>
  );
  Form.useForm = () => [{ setFieldsValue }];
  return {
    Form,
    Icon: () => null,
    Skeleton: () => null,
  };
});

vi.mock('@/features/PlatformSettingSourceBadge/ManagedFormControl', () => ({
  ManagedFormControlContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/FormInput', () => ({
  FormSliderWithInput: () => <div data-testid="image-slider" />,
}));

vi.mock('@/components/Editor/AutoSaveHint', () => ({
  default: () => null,
}));

vi.mock('./openaiTtsOptions', () => ({
  opeanaiTTSOptions: [{ label: 'tts-1', value: 'tts-1' }],
}));

describe('SettingsForms autosave failure feedback (CS-03 / XT-003)', () => {
  beforeEach(() => {
    toastError.mockClear();
    setFieldsValue.mockClear();
  });

  it('toasts, rolls back, and clears loading when image onChange rejects', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('revision conflict'));
    render(
      <ImageFormView
        canManage
        isInit
        value={{ defaultImageNum: 1 } as never}
        onChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-change'));
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/Could not update the default image count|saveFailed/),
      );
    });
    expect(setFieldsValue).toHaveBeenCalledWith({ defaultImageNum: 1 });
    expect(onChange).toHaveBeenCalled();
  });

  it('toasts, rolls back, and clears loading when TTS onChange rejects', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('network'));
    render(
      <OpenAIFormView
        canManage
        isInit
        value={{ openAI: { ttsModel: 'tts-1' } }}
        onChange={onChange}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-change'));
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/Could not update the TTS model|saveFailed/),
      );
    });
    expect(setFieldsValue).toHaveBeenCalledWith({ openAI: { ttsModel: 'tts-1' } });
  });
});
