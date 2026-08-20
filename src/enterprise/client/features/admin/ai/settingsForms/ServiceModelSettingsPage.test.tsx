// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { render } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ServiceModelSettingsPage from './ServiceModelSettingsPage';

const mocks = vi.hoisted(() => ({
  formProps: null as null | Record<string, unknown>,
  scope: {
    canWrite: true,
    clearDirtyDraftBlocked: vi.fn(),
    defaultAgent: { config: { model: 'gpt', provider: 'openai' } },
    dirtyDraftBlocked: false,
    error: null as unknown,
    image: {},
    isInit: true,
    mappedError: null as null | { code: string; i18nKey: string },
    mutate: vi.fn(),
    systemAgent: {},
    tts: {},
    updateDefaultAgentEffort: vi.fn(),
    updateDefaultAgentModel: vi.fn(),
    updateImage: vi.fn(),
    updateSystemAgent: vi.fn(),
    updateTts: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/enterprise/client/features/admin/primitives/AdminPageTemplate', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock(
  '@/enterprise/client/features/admin/ai/providerSettings/AdminProviderSettingsStore',
  () => ({
    AdminProviderSettingsStoreProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  }),
);

vi.mock('@/store/aiInfra', () => ({
  useScopedAiInfraStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      useFetchAiProviderList: () => undefined,
      useFetchAiProviderRuntimeState: () => ({ error: null, mutate: vi.fn() }),
    }),
}));

vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: (s: unknown) => s,
  useServerConfigStore: (selector: (s: { enableSTT: boolean; showAiImage: boolean }) => unknown) =>
    selector({ enableSTT: false, showAiImage: false }),
}));

vi.mock('@/hooks/useSaveState', () => ({
  useSaveState: () => ({ lastSavedAt: null, retry: vi.fn(), save: vi.fn(), status: 'idle' }),
}));

vi.mock('@/features/ServiceModel', () => ({
  ModelAssignmentsFormView: (props: Record<string, unknown>) => {
    mocks.formProps = props;
    return <div data-testid="model-assignments" />;
  },
}));

vi.mock('@/features/SettingsForms', () => ({
  ImageFormView: () => null,
  OpenAIFormView: () => null,
}));

vi.mock('./DirtyDraftAlert', () => ({ default: () => null }));

vi.mock('./usePlatformSettingsDefaults', () => ({
  usePlatformSettingsDefaults: () => mocks.scope,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>{children}</MotionProvider>
);

describe('ServiceModelSettingsPage default-assistant effort', () => {
  beforeEach(() => {
    mocks.formProps = null;
    mocks.scope.updateDefaultAgentEffort = vi.fn();
  });

  it('passes onUpdateDefaultAgentEffort through to the form', () => {
    render(<ServiceModelSettingsPage />, { wrapper });
    expect(mocks.formProps?.onUpdateDefaultAgentEffort).toBe(mocks.scope.updateDefaultAgentEffort);
    expect(mocks.formProps?.defaultAgentEffortClearable).toBe(true);
  });
});
