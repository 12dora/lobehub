// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DependencyEditor } from './DependencyEditor';
import type { AdminAgentDraftDependencies } from './types';

const hooks = vi.hoisted(() => ({
  connectorDetail: {} as Record<string, unknown>,
  /** Per-id detail states, so a queue of picks can settle one connector at a time. */
  connectorDetailById: {} as Record<string, Record<string, unknown>>,
  connectorRefDetails: {} as Record<string, unknown>,
  connectors: {} as Record<string, unknown>,
  providerQueries: [] as (string | undefined)[],
  providers: {} as Record<string, unknown>,
  skills: {} as Record<string, unknown>,
  source: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('./useDependencyCatalog', () => ({
  useAdminConnectorDetail: (connectorId?: string) =>
    (connectorId ? hooks.connectorDetailById[connectorId] : undefined) ?? hooks.connectorDetail,
  useAdminConnectorDetails: () => hooks.connectorRefDetails,
  useAdminProviderModelSource: () => hooks.source,
  useAdminPublishedConnectors: () => hooks.connectors,
  // The query is the SWR key: recording it proves the typed search reaches the server, not just
  // the Select's local filter over the page already loaded.
  useAdminPublishedProviders: (_enabled: boolean, query?: string) => {
    hooks.providerQueries.push(query);
    return hooks.providers;
  },
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
  Icon: () => <i />,
  Input: ({ 'aria-label': label, value, onChange, ...props }: any) => (
    <input
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange?.(event)}
      {...props}
    />
  ),
  NeuralNetworkLoading: () => null,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children, title }: any) => <span data-tooltip={String(title)}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, href, ...props }: any) =>
    href ? (
      <a href={href} {...props}>
        {children}
      </a>
    ) : (
      <button {...props}>{children}</button>
    ),
  Input: ({ 'aria-label': label, value, onChange, ...props }: any) => (
    <input
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange?.(event)}
      {...props}
    />
  ),
  Select: ({
    'aria-label': label,
    disabled,
    id,
    mode,
    options,
    required,
    value,
    onChange,
  }: any) => (
    <select
      aria-label={label}
      disabled={disabled}
      id={id}
      required={required}
      onChange={(event) => {
        const picked = event.target.value;
        if (mode !== 'multiple') return onChange?.(picked);
        // A multiple Select toggles exactly one option per interaction.
        const current: string[] = Array.isArray(value) ? value : [];
        onChange?.(
          current.includes(picked)
            ? current.filter((entry) => entry !== picked)
            : [...current, picked],
        );
      }}
    >
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
const page = <T,>(items: T[], truncated = false) => ({ items, truncated });

beforeEach(() => {
  hooks.providerQueries = [];
  hooks.providers = { ...idle };
  hooks.skills = { ...idle, data: [] };
  hooks.connectors = { ...idle, data: page([]) };
  hooks.source = { ...idle };
  hooks.connectorDetail = { ...idle };
  hooks.connectorDetailById = {};
  hooks.connectorRefDetails = { ...idle };
});

const currentModel = () => {
  hooks.providers = {
    ...idle,
    data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
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

const renderReadOnlyEditor = (deps: AdminAgentDraftDependencies) =>
  render(
    <DependencyEditor
      agentId="agent-1"
      dependencies={deps}
      editable={false}
      enabled={false}
      onChange={vi.fn()}
    />,
  );

describe('DependencyEditor exact authoring', () => {
  it('does not show a permanent connector validation state when read-only catalog reads are off', () => {
    renderReadOnlyEditor({ connectors: [connectorRef], model: currentModel(), skills: [] });

    expect(screen.queryByText('agentCatalog.dependency.connector.validating')).toBeNull();
    expect(screen.getByText('issues')).toBeTruthy();
  });

  it('shows loading / error / empty / unresolvable model states', () => {
    hooks.providers = { ...idle, isLoading: true };
    const { unmount } = renderEditor(emptyDeps());
    expect(screen.getAllByText('agentCatalog.dependency.loading').length).toBeGreaterThan(0);
    unmount();

    hooks.providers = { ...idle, error: new Error('x') };
    const r2 = renderEditor(emptyDeps());
    expect(screen.getByText('agentCatalog.dependency.model.loadError')).toBeTruthy();
    r2.unmount();

    hooks.providers = { ...idle, data: page([]) };
    const r3 = renderEditor(emptyDeps());
    expect(screen.getByText('agentCatalog.dependency.model.empty')).toBeTruthy();
    r3.unmount();

    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
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
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
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
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
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
    // One control: picking it is the whole gesture — the exact detail is fetched and applied for you.
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
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

  it('removes an existing connector dependency by unpicking it', () => {
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
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
    const onChange = vi.fn();
    renderEditor(deps, onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
    expect(onChange).toHaveBeenCalledWith({ connectors: [], model: null, skills: [] });
  });

  it('keeps a referenced connector the catalog no longer lists pickable, so it can be dropped', () => {
    const deps: AdminAgentDraftDependencies = {
      connectors: [connectorRef],
      model: null,
      skills: [],
    };
    const onChange = vi.fn();
    renderEditor(deps, onChange);
    const picker = screen.getByLabelText('agentCatalog.dependency.connector.add');
    expect([...picker.querySelectorAll('option')].map((option) => option.value)).toContain('c1');
    fireEvent.change(picker, { target: { value: 'c1' } });
    expect(onChange).toHaveBeenCalledWith({ connectors: [], model: null, skills: [] });
  });

  it('adds and drops a Skill through the one picker', () => {
    const skillOption = {
      checksum: 'f'.repeat(64),
      displayName: 'Writer',
      distribution: 'optional',
      skillKey: 'writer',
      version: '1.0.0',
    };
    hooks.skills = { ...idle, data: [skillOption] };
    const onChange = vi.fn();
    const { rerender } = renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.skill.add'), {
      target: { value: 'writer' },
    });
    const added = {
      checksum: 'f'.repeat(64),
      skillKey: 'writer',
      version: '1.0.0',
    };
    expect(onChange).toHaveBeenCalledWith({ connectors: [], model: null, skills: [added] });

    onChange.mockClear();
    rerender(
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={{ connectors: [], model: null, skills: [added] }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.skill.add'), {
      target: { value: 'writer' },
    });
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
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
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
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
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

  it('reports a hidden Skill catalog failure as a save blocker carrying its retry', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const model = currentModel();
    hooks.skills = { ...idle, error: new Error('offline'), mutate };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
    const { blockers } = onValidity.mock.calls.at(-1)![0] as {
      blockers: { message: string; retry?: () => Promise<unknown> }[];
    };
    expect(blockers.map((blocker) => blocker.message)).toEqual([
      'agentCatalog.dependency.skill.loadError',
    ]);
    void blockers[0]!.retry?.();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('reports a still-loading Connector catalog as a save blocker with no retry', async () => {
    const model = currentModel();
    hooks.connectors = { ...idle, data: undefined, isLoading: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
    const { blockers } = onValidity.mock.calls.at(-1)![0] as {
      blockers: { message: string; retry?: () => Promise<unknown> }[];
    };
    expect(blockers).toEqual([{ message: 'agentCatalog.editor.blocked.connectorCatalog' }]);
  });

  it('reports no blockers once every catalog is settled', async () => {
    const model = currentModel();
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: true })),
    );
    expect(onValidity.mock.calls.at(-1)![0].blockers).toEqual([]);
  });

  it('names the unchosen model as a save blocker instead of failing silently', async () => {
    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
    };
    const onValidity = vi.fn();
    renderEditor(emptyDeps(), vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
    const { blockers } = onValidity.mock.calls.at(-1)![0] as { blockers: { message: string }[] };
    expect(blockers).toContainEqual({ message: 'agentCatalog.editor.blocked.model' });
  });

  it('reports the revalidating provider catalog as a save blocker', async () => {
    const model = currentModel();
    hooks.providers = { ...hooks.providers, isValidating: true }; // retained list + revalidation
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
    const { blockers } = onValidity.mock.calls.at(-1)![0] as { blockers: { message: string }[] };
    expect(blockers).toContainEqual({ message: 'agentCatalog.editor.blocked.providerCatalog' });
  });

  it('reports a failed provider catalog as a save blocker carrying its retry', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const model = currentModel();
    hooks.providers = { ...hooks.providers, error: new Error('offline'), mutate };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model, skills: [] }, vi.fn(), onValidity);

    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
    const { blockers } = onValidity.mock.calls.at(-1)![0] as {
      blockers: { message: string; retry?: () => Promise<unknown> }[];
    };
    const blocker = blockers.find(
      (entry) => entry.message === 'agentCatalog.dependency.model.loadError',
    );
    void blocker!.retry?.();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it('sends the admin to the provider catalog when nothing is published yet', () => {
    hooks.providers = { ...idle, data: page([]) };
    renderEditor(emptyDeps());
    expect(screen.getByText('agentCatalog.dependency.model.emptyAction').getAttribute('href')).toBe(
      '/admin/ai/providers',
    );
  });

  it('resets the provider selection when the Agent context changes', () => {
    hooks.providers = {
      ...idle,
      data: page([
        { displayName: 'OpenAI', id: 'p1', providerKey: 'openai' },
        { displayName: 'Anthropic', id: 'p2', providerKey: 'anthropic' },
      ]),
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

describe('DependencyEditor fails closed on the provider list / connector list / current detail (T1)', () => {
  const model = () => ({
    modelKey: 'gpt-4.1',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'openai',
    providerRevision: 4,
  });

  it('blocks save when the provider LIST errors while retaining matching data', async () => {
    currentModel();
    hooks.providers = { ...hooks.providers, error: new Error('flaky') }; // retained list + error
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: model(), skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save + shows a revalidating hint while the provider LIST revalidates (data retained)', async () => {
    currentModel();
    hooks.providers = { ...hooks.providers, isValidating: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: model(), skills: [] }, vi.fn(), onValidity);
    expect(screen.getByText('agentCatalog.dependency.revalidating')).toBeTruthy();
    await waitFor(() =>
      expect(onValidity).toHaveBeenCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('surfaces the connector LIST error with a retry (Add picker not offered from a stale list)', () => {
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
      error: new Error('x'),
    };
    renderEditor(emptyDeps(), vi.fn());
    expect(screen.getByText('agentCatalog.dependency.connector.loadError')).toBeTruthy();
    expect(screen.getByText('agentCatalog.dependency.retry')).toBeTruthy();
  });

  it('shows a revalidating hint while the connector LIST revalidates with data retained', () => {
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
      isValidating: true,
    };
    renderEditor(emptyDeps(), vi.fn());
    expect(screen.getByText('agentCatalog.dependency.revalidating')).toBeTruthy();
  });

  it('will NOT author a connector while the current detail is revalidating (retained data)', () => {
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
    hooks.connectorDetail = { ...idle, data: connectorDetail, isValidating: true }; // retained + revalidating
    const onChange = vi.fn();
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
    // The pick is held, not authored: fail closed, never build a ref from a stale snapshot.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('agentCatalog.dependency.revalidating')).toBeTruthy();
  });

  it('will NOT author a connector while the current detail errors with retained data (retry offered)', () => {
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
    hooks.connectorDetail = { ...idle, data: connectorDetail, error: new Error('x') };
    const onChange = vi.fn();
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
    // The error branch states the failure and offers a retry instead of authoring the ref.
    expect(screen.getByText('agentCatalog.dependency.retry')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('authors the connector only AFTER the current detail settles (no error, not revalidating)', () => {
    hooks.providers = { ...idle, data: page([]) };
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
    hooks.connectorDetail = { ...idle, data: connectorDetail }; // settled success
    const onChange = vi.fn();
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });
    expect(onChange).toHaveBeenCalledTimes(1); // settled → authored exactly once
  });
});

describe('DependencyEditor requires ALL authorable catalogs fresh even with EMPTY refs (U1)', () => {
  const skillOption = {
    checksum: 'f'.repeat(64),
    displayName: 'Writer',
    distribution: 'optional',
    skillKey: 'writer',
    version: '1.0.0',
  };

  it('blocks save when the Skill catalog errors even though there are NO skill refs', async () => {
    const m = currentModel();
    hooks.skills = { ...idle, data: [], error: new Error('x') }; // authorable catalog is unhealthy
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save while the Skill catalog revalidates (retained data) with NO skill refs', async () => {
    const m = currentModel();
    hooks.skills = { ...idle, data: [skillOption], isValidating: true };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save when the Connector list errors even though there are NO connector refs', async () => {
    const m = currentModel();
    hooks.connectors = { ...idle, data: page([]), error: new Error('x') };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('blocks save while the Connector list revalidates (retained data) with NO connector refs', async () => {
    const m = currentModel();
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
      isValidating: true,
    };
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );
  });

  it('disables the provider selector while the provider list revalidates with retained data', () => {
    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
      isValidating: true,
    };
    renderEditor(emptyDeps());
    const select = screen.getByLabelText(
      'agentCatalog.dependency.model.provider',
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('refuses a model change while the model source revalidates with retained data', () => {
    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
    };
    hooks.source = {
      ...idle,
      data: {
        chatModels: [{ displayName: 'GPT-4.1', modelKey: 'gpt-4.1', type: 'chat' }],
        providerChecksum: 'a'.repeat(64),
        providerKey: 'openai',
        providerRevision: 4,
      },
      isValidating: true, // retained data, but revalidating
    };
    const onChange = vi.fn();
    renderEditor(emptyDeps(), onChange);
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.model.provider'), {
      target: { value: 'p1' },
    });
    const modelSelect = screen.getByLabelText(
      'agentCatalog.dependency.model.model',
    ) as HTMLSelectElement;
    expect(modelSelect.disabled).toBe(true);
    fireEvent.change(modelSelect, { target: { value: 'gpt-4.1' } });
    expect(onChange).not.toHaveBeenCalled(); // change refused → never author from a stale source
  });

  it('disables the skill selector while the skill catalog revalidates with retained data', () => {
    hooks.skills = { ...idle, data: [skillOption], isValidating: true };
    renderEditor(emptyDeps());
    const select = screen.getByLabelText('agentCatalog.dependency.skill.add') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('restores readiness after a skill-catalog retry settles to a fresh success', async () => {
    const m = currentModel();
    hooks.skills = { ...idle, data: [], error: new Error('x') };
    const onValidity = vi.fn();
    const view = renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );

    hooks.skills = { ...idle, data: [] }; // retry settles: no error, not validating
    view.rerender(
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={{ connectors: [], model: m, skills: [] }}
        onChange={vi.fn()}
        onValidityChange={onValidity}
      />,
    );
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });
});

describe('DependencyEditor: a SELECTED connector requires a settled current detail for readiness', () => {
  const withList = () => {
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
    };
  };
  const selectConnector = () =>
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: 'c1' },
    });

  it('stays ready with NO connector selected (a current detail is not required)', async () => {
    const m = currentModel();
    withList();
    const onValidity = vi.fn();
    renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ['undefined / loading', { ...idle, isLoading: true }],
    ['retained data + error', { ...idle, data: connectorDetail, error: new Error('x') }],
    ['retained data + isValidating', { ...idle, data: connectorDetail, isValidating: true }],
    ['null / unresolvable', { ...idle, data: null }],
  ])(
    'drops onValidityChange.ready to false once a connector is selected and its detail is %s',
    async (_label, detailState) => {
      const m = currentModel();
      withList();
      hooks.connectorDetail = detailState;
      const onValidity = vi.fn();
      renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
      // Ready BEFORE selecting — no current detail required yet.
      await waitFor(() =>
        expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
      );
      // Selecting a connector puts an authoring op in flight → its unsettled detail fails closed.
      selectConnector();
      await waitFor(() =>
        expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
      );
    },
  );

  it('returns ready:true after the selected connector detail settles to a resolved success', async () => {
    const m = currentModel();
    withList();
    hooks.connectorDetail = { ...idle, data: connectorDetail, error: new Error('x') };
    const onValidity = vi.fn();
    const view = renderEditor({ connectors: [], model: m, skills: [] }, vi.fn(), onValidity);
    selectConnector();
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );

    // Retry settles: resolved detail, no error, not validating → ready again.
    hooks.connectorDetail = { ...idle, data: connectorDetail };
    view.rerender(
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={{ connectors: [], model: m, skills: [] }}
        onChange={vi.fn()}
        onValidityChange={onValidity}
      />,
    );
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  it('refuses connector selection while the connector LIST revalidates (picker disabled)', () => {
    currentModel();
    hooks.connectors = {
      ...idle,
      data: page([{ displayName: 'Issues', id: 'c1', key: 'issues' }]),
      isValidating: true,
    };
    renderEditor(emptyDeps());
    const picker = screen.getByLabelText(
      'agentCatalog.dependency.connector.add',
    ) as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
  });
});

describe('DependencyEditor queues EVERY connector pick until its exact detail settles', () => {
  /** The host owns the draft, so a dropped pick shows up as a connector missing from the state. */
  const ControlledEditor = ({
    onValidity,
    state,
  }: {
    onValidity?: (validity: unknown) => void;
    state: { dependencies: AdminAgentDraftDependencies };
  }) => {
    const [dependencies, setDependencies] = useState(state.dependencies);
    state.dependencies = dependencies;
    return (
      <DependencyEditor
        editable
        enabled
        agentId="agent-1"
        dependencies={dependencies}
        onChange={setDependencies}
        onValidityChange={onValidity}
      />
    );
  };

  const detailOf = (connectorId: string, connectorKey: string) => ({
    connectorId,
    connectorKey,
    publishedChecksum: 'e'.repeat(64),
    publishedRevision: 3,
    tools: [{ platformPolicy: 'allow', toolKey: 'search' }],
  });

  const refOf = (connectorId: string, connectorKey: string) => ({
    allowedToolKeys: ['search'],
    connectorId,
    connectorKey,
    publishedChecksum: 'e'.repeat(64),
    publishedRevision: 3,
  });

  const twoPickable = () => {
    hooks.connectors = {
      ...idle,
      data: page([
        { displayName: 'Issues', id: 'c1', key: 'issues' },
        { displayName: 'Docs', id: 'c2', key: 'docs' },
      ]),
    };
    hooks.connectorDetailById = {
      c1: { ...idle, isLoading: true },
      c2: { ...idle, isLoading: true },
    };
  };

  const pick = (connectorId: string) =>
    fireEvent.change(screen.getByLabelText('agentCatalog.dependency.connector.add'), {
      target: { value: connectorId },
    });

  it('keeps the first pick when a second is made before its detail resolves', () => {
    currentModel();
    twoPickable();
    const state = { dependencies: emptyDeps() };
    const view = render(<ControlledEditor state={state} />);

    pick('c1');
    pick('c2'); // while c1 is still resolving — it must not replace c1

    // Nothing is authored yet: neither detail has settled.
    expect(state.dependencies.connectors).toEqual([]);

    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    view.rerender(<ControlledEditor state={state} />);
    expect(state.dependencies.connectors).toEqual([refOf('c1', 'issues')]);

    hooks.connectorDetailById.c2 = { ...idle, data: detailOf('c2', 'docs') };
    view.rerender(<ControlledEditor state={state} />);
    // The queued second pick survived the first one's resolution.
    expect(state.dependencies.connectors).toEqual([refOf('c1', 'issues'), refOf('c2', 'docs')]);
  });

  it('cancels a queued pick when it is unpicked before its detail resolves', () => {
    currentModel();
    twoPickable();
    const state = { dependencies: emptyDeps() };
    const view = render(<ControlledEditor state={state} />);

    pick('c1');
    pick('c2');
    pick('c1'); // taken back while still queued

    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    hooks.connectorDetailById.c2 = { ...idle, data: detailOf('c2', 'docs') };
    view.rerender(<ControlledEditor state={state} />);

    // Only the pick that was still queued is authored; the cancelled one never lands.
    expect(state.dependencies.connectors).toEqual([refOf('c2', 'docs')]);
  });

  it('FAILS CLOSED while ANY pick is still queued, and clears once they all settle', async () => {
    const model = currentModel();
    twoPickable();
    const onValidity = vi.fn();
    const state = { dependencies: { connectors: [], model, skills: [] } };
    const view = render(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );

    pick('c1');
    pick('c2');
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );

    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    view.rerender(<ControlledEditor state={state} onValidity={onValidity} />);
    // The second pick is still resolving → save stays closed.
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false })),
    );

    hooks.connectorDetailById.c2 = { ...idle, data: detailOf('c2', 'docs') };
    hooks.connectorRefDetails = {
      ...idle,
      data: { c1: detailOf('c1', 'issues'), c2: detailOf('c2', 'docs') },
    };
    view.rerender(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  it('never authors a queued pick after the editor is unmounted', () => {
    currentModel();
    twoPickable();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { dependencies: emptyDeps() };
    const view = render(<ControlledEditor state={state} />);

    pick('c1');
    view.unmount();

    // The detail arriving after teardown reaches nothing: no author, no state update, no warning.
    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    expect(state.dependencies.connectors).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('will not author a pick from a detail that belongs to another connector', () => {
    currentModel();
    twoPickable();
    // The stale snapshot of a previously fetched connector must never be applied to this pick.
    hooks.connectorDetailById.c2 = { ...idle, data: detailOf('c1', 'issues') };
    const state = { dependencies: emptyDeps() };
    render(<ControlledEditor state={state} />);

    pick('c2');
    expect(state.dependencies.connectors).toEqual([]);
  });

  it('never reports ready between the picks and BOTH the queue draining and the batch validating', async () => {
    const model = currentModel();
    twoPickable();
    const onValidity = vi.fn();
    const state = { dependencies: { connectors: [], model, skills: [] } };
    const view = render(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );

    pick('c1');
    pick('c2');
    onValidity.mockClear();
    const readyStates = () =>
      (onValidity.mock.calls as [{ ready: boolean }][]).map(([validity]) => validity.ready);

    // The head settling makes it authorable, NOT saveable: c2 is still queued behind it, so a
    // ready:true here would let a snapshot commit without c2.
    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    view.rerender(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() => expect(state.dependencies.connectors).toHaveLength(1));
    expect(readyStates()).not.toContain(true);

    // Queue drained — but the two freshly authored refs have not been batch-validated yet.
    hooks.connectorDetailById.c2 = { ...idle, data: detailOf('c2', 'docs') };
    view.rerender(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() => expect(state.dependencies.connectors).toHaveLength(2));
    expect(readyStates()).not.toContain(true);

    hooks.connectorRefDetails = {
      ...idle,
      data: { c1: detailOf('c1', 'issues'), c2: detailOf('c2', 'docs') },
    };
    view.rerender(<ControlledEditor state={state} onValidity={onValidity} />);
    await waitFor(() =>
      expect(onValidity).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true })),
    );
  });

  /** One editor instance, one draft per Agent — exactly how the host swaps the edited Agent. */
  const MultiAgentEditor = ({
    agentId,
    drafts,
  }: {
    agentId: string;
    drafts: Record<string, AdminAgentDraftDependencies>;
  }) => {
    const [, bump] = useState(0);
    return (
      <DependencyEditor
        editable
        enabled
        agentId={agentId}
        dependencies={drafts[agentId]}
        onChange={(next) => {
          drafts[agentId] = next;
          bump((value) => value + 1);
        }}
      />
    );
  };

  it('never authors a queued pick into the draft of the Agent switched to', () => {
    currentModel();
    twoPickable();
    const drafts: Record<string, AdminAgentDraftDependencies> = {
      'agent-1': emptyDeps(),
      'agent-2': emptyDeps(),
    };
    const view = render(<MultiAgentEditor agentId="agent-1" drafts={drafts} />);

    pick('c1');
    // The detail lands in the very flush that switches Agent: the queue belongs to agent-1, so it
    // must be gone for agent-1 (never committed) and invisible to agent-2.
    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    view.rerender(<MultiAgentEditor agentId="agent-2" drafts={drafts} />);

    expect(drafts['agent-2'].connectors).toEqual([]);
    expect(drafts['agent-1'].connectors).toEqual([]);
  });

  it('drops a queued update when the stale row is removed before its detail settles', () => {
    currentModel();
    twoPickable();
    // c1 is referenced but drifted, so its row offers Update / Remove.
    hooks.connectorRefDetails = {
      ...idle,
      data: { c1: { ...detailOf('c1', 'issues'), publishedRevision: 4 } },
    };
    const state = {
      dependencies: { connectors: [refOf('c1', 'issues')], model: null, skills: [] },
    };
    const view = render(<ControlledEditor state={state} />);

    fireEvent.click(screen.getByText('agentCatalog.dependency.connector.update'));
    fireEvent.click(screen.getByText('agentCatalog.dependency.connector.remove'));
    expect(state.dependencies.connectors).toEqual([]);

    // The update the admin abandoned must not resurrect the row it removed.
    hooks.connectorDetailById.c1 = { ...idle, data: detailOf('c1', 'issues') };
    view.rerender(<ControlledEditor state={state} />);
    expect(state.dependencies.connectors).toEqual([]);
  });
});

describe('DependencyEditor provider search reaches the server', () => {
  const searchLabel = 'agentCatalog.dependency.model.providerSearch';

  it('sends the typed query to the catalog hook once the loaded page is truncated', async () => {
    // A truncated page means matching providers exist beyond it — a local filter would never
    // reach them, so the query has to become part of the catalog SWR key.
    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }], true),
    };
    renderEditor(emptyDeps());

    fireEvent.change(screen.getByLabelText(searchLabel), { target: { value: 'anthropic' } });
    await waitFor(() => expect(hooks.providerQueries).toContain('anthropic'));
  });

  it('keeps the box out of the way while the whole published catalog fits on one page', () => {
    hooks.providers = {
      ...idle,
      data: page([{ displayName: 'OpenAI', id: 'p1', providerKey: 'openai' }]),
    };
    renderEditor(emptyDeps());
    expect(screen.queryByLabelText(searchLabel)).toBeNull();
  });

  it('binds the provider and model labels to their controls and marks both required', () => {
    currentModel();
    renderEditor(emptyDeps());
    for (const field of ['provider', 'model'] as const) {
      const label = [...document.querySelectorAll('label')].find(
        (node) => node.textContent === `agentCatalog.dependency.model.${field}*`,
      );
      const control = screen.getByLabelText(`agentCatalog.dependency.model.${field}`);
      expect(label!.getAttribute('for')).toBe(control.id);
      expect(control).toBeRequired();
    }
  });
});
