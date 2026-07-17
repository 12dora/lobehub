// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DependencyEditor } from './DependencyEditor';
import type { AdminAgentDraftDependencies } from './types';

const hooks = vi.hoisted(() => ({
  providers: {} as Record<string, unknown>,
  skills: {} as Record<string, unknown>,
  source: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ label: '', mono: '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('./useDependencyCatalog', () => ({
  useAdminProviderModelSource: () => hooks.source,
  useAdminPublishedProviders: () => hooks.providers,
  useAdminPublishedSkills: () => hooks.skills,
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({
    action,
    description,
    message,
  }: {
    action?: ReactNode;
    description?: ReactNode;
    message?: ReactNode;
  }) => (
    <div>
      <span>{message}</span>
      <span>{description}</span>
      {action}
    </div>
  ),
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: ({ 'aria-label': label, options, onChange }: any) => (
    <select aria-label={label} onChange={(event) => onChange?.(event.target.value)}>
      <option value="">--</option>
      {(options ?? []).map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const emptyDeps = (): AdminAgentDraftDependencies => ({ connectors: [], model: null, skills: [] });

const idle = { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };

beforeEach(() => {
  hooks.providers = { ...idle };
  hooks.skills = { ...idle, data: [] };
  hooks.source = { ...idle };
});

describe('DependencyEditor UI-01 exact authoring', () => {
  it('shows the loading state while the provider catalog loads', () => {
    hooks.providers = { ...idle, isLoading: true };
    render(<DependencyEditor editable enabled dependencies={emptyDeps()} onChange={vi.fn()} />);
    expect(screen.getAllByText('agentCatalog.dependency.loading').length).toBeGreaterThan(0);
  });

  it('shows a retryable error when the catalog fails', () => {
    hooks.providers = { ...idle, error: new Error('x') };
    render(<DependencyEditor editable enabled dependencies={emptyDeps()} onChange={vi.fn()} />);
    expect(screen.getByText('agentCatalog.dependency.model.loadError')).toBeTruthy();
    expect(screen.getByText('agentCatalog.dependency.retry')).toBeTruthy();
  });

  it('shows the empty state when no providers are published', () => {
    hooks.providers = { ...idle, data: [] };
    render(<DependencyEditor editable enabled dependencies={emptyDeps()} onChange={vi.fn()} />);
    expect(screen.getByText('agentCatalog.dependency.model.empty')).toBeTruthy();
  });

  it('warns when a provider has no resolvable published checksum', () => {
    hooks.providers = {
      ...idle,
      data: [{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }],
    };
    hooks.source = { ...idle, data: null };
    const { container } = render(
      <DependencyEditor editable enabled dependencies={emptyDeps()} onChange={vi.fn()} />,
    );
    // Select the provider so the source hook result renders.
    fireEvent.change(container.querySelector('select')!, { target: { value: 'p1' } });
    expect(screen.getByText('agentCatalog.dependency.model.unresolvable')).toBeTruthy();
  });

  it('always renders the connector deferral gate', () => {
    hooks.providers = { ...idle, data: [] };
    render(<DependencyEditor editable enabled dependencies={emptyDeps()} onChange={vi.fn()} />);
    expect(screen.getByText('agentCatalog.dependency.connector.deferredTitle')).toBeTruthy();
  });

  it('builds an exact model dependency from the resolved source on selection', () => {
    hooks.providers = {
      ...idle,
      data: [{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }],
    };
    hooks.source = {
      ...idle,
      data: {
        chatModels: [{ displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' }],
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 4,
      },
    };
    const onChange = vi.fn();
    const { container } = render(
      <DependencyEditor editable enabled dependencies={emptyDeps()} onChange={onChange} />,
    );
    const selects = container.querySelectorAll('select');
    fireEvent.change(selects[0]!, { target: { value: 'p1' } }); // provider
    const modelSelect = screen.getByLabelText('agentCatalog.dependency.model.model');
    fireEvent.change(modelSelect, { target: { value: 'gpt-4.1' } });

    expect(onChange).toHaveBeenCalledWith({
      connectors: [],
      model: {
        modelKey: 'gpt-4.1',
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 4,
      },
      skills: [],
    });
  });
});
