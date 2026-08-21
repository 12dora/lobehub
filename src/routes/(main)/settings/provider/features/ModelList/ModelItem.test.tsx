import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ModelItem from './ModelItem';

const mocks = vi.hoisted(() => ({
  managed: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/icons', () => ({
  ModelIcon: () => <span data-testid="model-icon" />,
}));

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ title, icon: _icon, ...props }: any) => (
    <button title={title} type="button" {...props} />
  ),
  Flexbox: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  Text: ({ children }: any) => <span>{children}</span>,
  copyToClipboard: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: vi.fn() }));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { success: vi.fn() } }) },
  Switch: (props: any) => <input role="switch" type="checkbox" {...props} />,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => 'style' }),
  cssVar: new Proxy({}, { get: () => 'var(--x)' }),
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({ managed: mocks.managed }),
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true, reason: 'requires owner' }),
}));

vi.mock('@/store/aiInfra', () => ({
  useAiInfraStoreApi: () => ({ getState: () => ({}) }),
  useScopedAiInfraStore: (selector: any) =>
    selector({
      activeAiProvider: 'openai',
      removeAiModel: vi.fn(),
      toggleModelEnabled: vi.fn(),
    }),
  aiModelSelectors: { isModelLoading: () => () => false },
}));

vi.mock('@/components/ModelSelect', () => ({
  ModelInfoTags: () => null,
}));
vi.mock('@/components/ModelSelect/NewModelBadge', () => ({ default: () => null }));
vi.mock('@/utils/format', () => ({ formatPriceByCurrency: (n: number) => String(n) }));
vi.mock('@/utils/pricing', () => ({
  getAudioInputUnitRate: () => undefined,
  getTextInputUnitRate: () => undefined,
  getTextOutputUnitRate: () => undefined,
}));

vi.mock('./ModelConfigModal', () => ({ createModelConfigModal: vi.fn() }));

vi.mock('./ProviderSettingsContext', async () => {
  const { createContext } = await import('react');
  return {
    ProviderSettingsContext: createContext({ modelEditable: true, showDeployName: false }),
  };
});

describe('ModelItem managed aiModels', () => {
  beforeEach(() => {
    mocks.managed = false;
  });

  it('hides toggle, edit, and delete when aiModels is managed', () => {
    mocks.managed = true;
    render(
      <ModelItem
        enabled
        abilities={{}}
        displayName="GPT-4o"
        id="gpt-4o"
        source={'custom' as never}
        type="chat"
      />,
    );

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('providerModels.item.config')).not.toBeInTheDocument();
    expect(screen.queryByTitle('providerModels.item.delete.title')).not.toBeInTheDocument();
  });

  it('renders a ChatGPT Web legacy alias as read-only with a family tag', () => {
    render(
      <ModelItem
        enabled
        abilities={{}}
        displayName="GPT-5.6 Thinking"
        id="gpt-5-6-thinking"
        settings={{ legacyAlias: 'gpt-5-6' }}
        source={'custom' as never}
        type="chat"
      />,
    );

    expect(screen.getByText('providerModels.item.legacyAlias.tag')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.queryByTitle('providerModels.item.config')).not.toBeInTheDocument();
    expect(screen.queryByTitle('providerModels.item.delete.title')).not.toBeInTheDocument();
  });
});
