// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import type { ModerationSettingsDraft } from '../draft';
import ClassifierSection from './ClassifierSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Tag: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
  Text: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Input: () => <input />,
  InputNumber: () => <input type="number" />,
  InputPassword: () => <input type="password" />,
  Select: () => <select />,
  TextArea: () => <textarea />,
}));
vi.mock('../SettingsSection', () => ({
  default: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock('../Field', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../ModelSelect', () => ({ default: () => <div data-testid="model-select" /> }));
vi.mock('../TestPanel', () => ({
  default: ({ persistedBaseUrl }: { persistedBaseUrl?: string }) => (
    <div data-testid="test-panel">{persistedBaseUrl ?? ''}</div>
  ),
}));

const draftWith = (baseUrl: string): ModerationSettingsDraft =>
  ({
    addedApiKeys: [],
    config: {
      ...createDefaultContentModerationConfig(),
      classifier: {
        kind: 'moderations_api',
        moderationsApi: {
          apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
          baseUrl,
          model: 'omni-moderation-latest',
        },
        onError: 'allow',
        retryCount: 1,
        timeoutMs: 3000,
      },
    },
  }) as unknown as ModerationSettingsDraft;

const renderSection = (baseUrl: string, persistedBaseUrl?: string) =>
  render(
    <ClassifierSection
      canManage
      catalog={[]}
      disabled={false}
      draft={draftWith(baseUrl)}
      persistedBaseUrl={persistedBaseUrl}
      onAddedKeysChange={vi.fn()}
      onPatch={vi.fn()}
    />,
  );

describe('ClassifierSection endpoint change', () => {
  it('stays quiet while the endpoint matches the one the keys were saved against', () => {
    renderSection('https://api.example.com/', 'https://api.example.com');
    expect(screen.queryByTestId('endpoint-changed-warning')).toBeNull();
    expect(screen.getByTestId('stored-key-fp-1').textContent).toBe('sk-…ab12');
  });

  it('warns and marks the stored keys for removal once the endpoint is edited', () => {
    renderSection('https://other.example.com', 'https://api.example.com');
    expect(screen.getByTestId('endpoint-changed-warning').textContent).toBe(
      'contentModeration.settings.classifier.endpointChanged',
    );
    expect(screen.getByTestId('stored-key-fp-1').textContent).toBe(
      'contentModeration.settings.classifier.keyWillBeRemoved',
    );
  });

  it('shows a server field rejection inline', () => {
    render(
      <ClassifierSection
        canManage
        catalog={[]}
        disabled={false}
        draft={draftWith('https://api.example.com')}
        fieldError={{ field: 'classifier.moderationsApi.baseUrl', message: 're-enter the keys' }}
        persistedBaseUrl="https://api.example.com"
        onAddedKeysChange={vi.fn()}
        onPatch={vi.fn()}
      />,
    );
    expect(screen.getByTestId('classifier-field-error').textContent).toBe('re-enter the keys');
  });

  it('passes the persisted endpoint down so 测试 uses the same key policy as 保存', () => {
    renderSection('https://api.example.com', 'https://api.example.com');
    expect(screen.getByTestId('test-panel').textContent).toBe('https://api.example.com');
  });
});
