import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAiInfraStore, useScopedAiInfraStore } from '@/store/aiInfra';

import ModelSelect from './index';

const managed = vi.hoisted(() => ({ aiModels: false, aiProviders: false }));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: (resource: 'aiModels' | 'aiProviders') => ({
    blocked: managed[resource],
  }),
}));

vi.mock('@lobehub/icons', () => ({ ModelIcon: () => <span /> }));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({ options }: { options?: Array<{ label?: ReactNode; options?: any[] }> }) => (
    <div>
      {options?.flatMap((option) =>
        option.options?.length
          ? option.options.map((child) => <div key={child.value}>{child.label}</div>)
          : [<div key={String(option.label)}>{option.label}</div>],
      )}
    </div>
  ),
  Switch: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <button aria-label={ariaLabel} role="switch" />
  ),
}));

const initialState = useAiInfraStore.getState();

afterEach(() => {
  managed.aiModels = false;
  managed.aiProviders = false;
  useAiInfraStore.setState(initialState, true);
});

const renderStaleModel = () => {
  useAiInfraStore.setState({
    builtinAiModelList: [
      {
        displayName: 'GPT stale',
        enabled: false,
        id: 'gpt-stale',
        providerId: 'openai',
        type: 'chat',
      } as any,
    ],
    enabledAiProviders: [{ id: 'openai' }] as any,
    enabledChatModelList: [],
    isInitAiProviderRuntimeState: true,
  });

  render(<ModelSelect value={{ model: 'gpt-stale', provider: 'openai' }} />);
};

/**
 * m4: Without AdminProviderSettingsStoreProvider, scoped hook reads the same
 * singleton as useAiInfraStore (zero user-behavior change).
 */
describe('ModelSelect scoped store smoke', () => {
  it('useScopedAiInfraStore matches useAiInfraStore singleton without a Provider', () => {
    const { result: scoped } = renderHook(() =>
      useScopedAiInfraStore((s) => s.enabledChatModelList),
    );
    const { result: global } = renderHook(() => useAiInfraStore((s) => s.enabledChatModelList));

    expect(scoped.current).toBe(global.current);
  });

  it('renders the stale-model enable switch when model governance is unmanaged', () => {
    renderStaleModel();

    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('hides the stale-model enable switch when either managed capability blocks mutation', () => {
    managed.aiModels = true;
    renderStaleModel();

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('GPT stale')).toBeInTheDocument();
  });
});
