// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DependencyEditor } from './DependencyEditor';
import type { AdminAgentDraftDependencies } from './types';

const hooks = vi.hoisted(() => ({
  connectorDetail: {} as Record<string, unknown>,
  connectorRefDetails: {} as Record<string, unknown>,
  connectors: {} as Record<string, unknown>,
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
  useAdminConnectorDetail: () => hooks.connectorDetail,
  useAdminConnectorDetails: () => hooks.connectorRefDetails,
  useAdminProviderModelSource: () => hooks.source,
  useAdminPublishedConnectors: () => hooks.connectors,
  useAdminPublishedProviders: () => hooks.providers,
  useAdminPublishedSkills: () => hooks.skills,
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, description, message }: any) => (
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
  hooks.connectors = { ...idle, data: [] };
  hooks.source = { ...idle };
  hooks.connectorDetail = { ...idle };
  hooks.connectorRefDetails = { ...idle };
});

const currentModel = () => {
  hooks.providers = { ...idle, data: [{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }] };
  hooks.source = {
    ...idle,
    data: {
      chatModels: [{ displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' }],
      providerChecksum: 'a'.repeat(64),
      providerKey: 'openai',
      providerRevision: 4,
    },
  };
  return {
    modelKey: 'gpt-4.1',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'openai',
    providerRevision: 4,
  };
};

const connectorRef = {
  allowedToolKeys: ['search'],
  connectorId: 'c1',
  connectorKey: 'issues',
  publishedChecksum: 'e'.repeat(64),
  publishedRevision: 3,
};
const connectorDetail = {
  connectorId: 'c1',
  connectorKey: 'issues',
  publishedChecksum: 'e'.repeat(64),
  publishedRevision: 3,
  tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
};

const renderEditor = (
  deps: AdminAgentDraftDependencies,
  onChange = vi.fn(),
  onValidity = vi.fn(),
) =>
  render(
    <DependencyEditor
      editable
      enabled
      agentId="agent-1"
      dependencies={deps}
      onChange={onChange}
      onValidityChange={onValidity}
    />,
  );

describe('DependencyEditor exact authoring', () => {
  it('shows loading / error / empty / unresolvable model states', () => {
    hooks.providers = { ...idle, isLoading: true };
    const { unmount } = renderEditor(emptyDeps());
    expect(screen.getAllByText('agentCatalog.dependency.loading').length).toBeGreaterThan(0);
    unmount();

    hooks.providers = { ...idle, error: new Error('x') };
    const r2 = renderEditor(emptyDeps());
    expect(screen.getByText('agentCatalog.dependency.model.loadError')).toBeTruthy();
    r2.unmount();

    hooks.providers = { ...idle, data: [] };
    const r3 = renderEditor(emptyDeps());
    expect(screen.getByText('agentCatalog.dependency.model.empty')).toBeTruthy();
    r3.unmount();

    hooks.providers = {
      ...idle,
      data: [{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }],
    };
    hooks.source = { ...idle, data: null };
    const r4 = renderEditor(emptyDeps());
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.model.provider'), {
      target: { value: 'p1' },
    });
    expect(screen.getByText('agentCatalog.dependency.model.unresolvable')).toBeTruthy();
    r4.unmount();
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
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.model.provider'), {
      target: { value: 'p1' },
    });
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.model.model'), {
      target: { value: 'gpt-4.1' },
    });
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

  it('adds an EXACT connector dependency (checksum + revision + tools) from the published catalog', () => {
    hooks.providers = { ...idle, data: [] };
    hooks.connectors = { ...idle, data: [{ displayName: 'Issues', id: 'c1', key: 'issues' }] };
    hooks.connectorDetail = {
      ...idle,
      data: {
        connectorId: 'c1',
        connectorKey: 'issues',
        publishedChecksum: 'e'.repeat(64),
        publishedRevision: 3,
        tools: [
          { platformPolicy: 'allow', toolKey: 'search' },
          { platformPolicy: 'deny', toolKey: 'delete' },
        ],
      },
    };
    const onChange = vi.fn();
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
    fireEvent.click(screen.getByText('agentCatalog.dependency.connector.addAction'));
    expect(onChange).toHaveBeenCalledWith({
      connectors: [
        {
          allowedToolKeys: ['search'], // deny-policy tools excluded
          connectorId: 'c1',
          connectorKey: 'issues',
          publishedChecksum: 'e'.repeat(64),
          publishedRevision: 3,
        },
      ],
      model: null,
      skills: [],
    });
  });

  it('removes an existing connector dependency', () => {
    const deps: AdminAgentDraftDependencies = {
      connectors: [
        {
          allowedToolKeys: ['search'],
          connectorId: 'c1',
          connectorKey: 'issues',
          publishedChecksum: 'e'.repeat(64),
          publishedRevision: 3,
        },
      ],
      model: null,
      skills: [],
    };
    const onChange = vi.fn();
    renderEditor(deps, onChange);
    fireEvent.click(screen.getByText('agentCatalog.dependency.connector.remove'));
    expect(onChange).toHaveBeenCalledWith({ connectors: [], model: null, skills: [] });
  });

  it('reports ready only when every ref matches the current published catalog', async () => {
    const model = {
      modelKey: 'gpt-4.1',
      providerChecksum: 'a'.repeat(64),
      providerKey: 'openai',
      providerRevision: 4,
    };
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
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  it('reports NOT ready and flags a stale model when the checksum no longer matches', async () => {
    const model = {
      modelKey: 'gpt-4.1',
      providerChecksum: 'a'.repeat(64),
      providerKey: 'openai',
      providerRevision: 4,
    };
    hooks.providers = {
      ...idle,
      data: [{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }],
    };
    hooks.source = {
      ...idle,
      data: {
        chatModels: [{ displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' }],
        providerChecksum: 'b'.repeat(64), // published checksum moved
        providerKey: 'openai',
        providerRevision: 5,
      },
    };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(
        expect.objectContaining({
          issues: ['agentCatalog.dependency.issues.modelStale'],
          ready: false,
        }),
      ),
    );
  });

  it('reports ready when a connector ref matches its fetched detail exactly', async () => {
    const model = currentModel();
    hooks.connectorRefDetails = { ...idle, data: { c1: connectorDetail } };
    const onValidity = vi.fn();
    renderEditor({ connectors: [connectorRef], model, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  it('flags a connector whose fetched detail no longer matches (revision drift)', async () => {
    const model = currentModel();
    hooks.connectorRefDetails = {
      ...idle,
      data: { c1: { ...connectorDetail, publishedRevision: 4 } },
    };
    const onValidity = vi.fn();
    renderEditor({ connectors: [connectorRef], model, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(
        expect.objectContaining({
          issues: ['agentCatalog.dependency.issues.connectorStale'],
          ready: false,
        }),
      ),
    );
  });

  it('FAILS CLOSED (not ready) while the referenced connector details are still loading', async () => {
    const model = currentModel();
    hooks.connectorRefDetails = { ...idle, data: undefined, isLoading: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [connectorRef], model, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('FAILS CLOSED (not ready) while the Skill catalog is still loading', async () => {
    const model = currentModel();
    hooks.skills = { ...idle, data: undefined, isLoading: true };
    const skillRef = { checksum: 'f'.repeat(64), skillKey: 'writer', version: '1.0.0' };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [skillRef] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('resets the provider selection when the Agent context changes', () => {
    hooks.providers = {
      ...idle,
      data: [
        { displayName: 'OpenAI', id: 'p1', providerKey: 'openai' },
        { displayName: 'Anthropic', id: 'p2', providerKey: 'anthropic' },
      ],
    };
    hooks.source = { ...idle, data: null };
    const { rerender } = render(
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={emptyDeps()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.model.provider'), {
      target: { value: 'p1' },
    });
    // Selecting a provider surfaced the (unresolvable) source panel.
    expect(screen.getByText('agentCatalog.dependency.model.unresolvable')).toBeTruthy();

    // Switching Agent must clear the transient provider selection → source panel gone.
    rerender(
      <DependencyEditor
        editable
        enabled
        agentId="agent-2"
        dependencies={emptyDeps()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText('agentCatalog.dependency.model.unresolvable')).toBeNull();
  });
});

describe('DependencyEditor fails closed on retained-data errors / revalidation (S1)', () => {
  const model = () => ({
    modelKey: 'gpt-4.1',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'openai',
    providerRevision: 4,
  });

  it('blocks save when the model source errors while retaining matching data', async () => {
    currentModel();
    hooks.source = { ...hooks.source, error: new Error('flaky') }; // retained matching data + error
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: model(), skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save while the model source is revalidating (matching data retained)', async () => {
    currentModel();
    hooks.source = { ...hooks.source, isValidating: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: model(), skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save + shows a retry when referenced-connector validation errors with retained data', async () => {
    currentModel();
    hooks.connectorRefDetails = { ...idle, data: { c1: connectorDetail }, error: new Error('x') };
    const onValidity = vi.fn();
    renderEditor({ connectors: [connectorRef], model: model(), skills: [] }, vi.fn(), onValidity);
    expect(screen.getByText('agentCatalog.dependency.connector.validateError')).toBeTruthy();
    expect(screen.getByText('agentCatalog.dependency.retry')).toBeTruthy();
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save + shows a validating hint while referenced-connector details revalidate', async () => {
    currentModel();
    hooks.connectorRefDetails = { ...idle, data: { c1: connectorDetail }, isValidating: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [connectorRef], model: model(), skills: [] }, vi.fn(), onValidity);
    expect(screen.getByText('agentCatalog.dependency.connector.validating')).toBeTruthy();
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('becomes ready only AFTER a retry resolves to a settled non-error, non-validating snapshot', async () => {
    currentModel();
    hooks.connectorRefDetails = { ...idle, data: { c1: connectorDetail }, error: new Error('x') };
    const onValidity = vi.fn();
    const view = renderEditor(
      { connectors: [connectorRef], model: model(), skills: [] },
      vi.fn(),
      onValidity,
    );
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );

    // Retry succeeds: data settled, no error, not validating → NOW ready.
    hooks.connectorRefDetails = { ...idle, data: { c1: connectorDetail } };
    view.rerender(
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={{ connectors: [connectorRef], model: model(), skills: [] }}
        onChange={vi.fn()}
        onValidityChange={onValidity}
      />,
    );
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });
});
