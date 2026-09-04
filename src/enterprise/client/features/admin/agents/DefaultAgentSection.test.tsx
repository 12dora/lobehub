// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DefaultAgentSection, type DefaultAgentSectionProps } from './DefaultAgentSection';
import type { AdminDefaultAgentSnapshot } from './useAdminAgents';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));
vi.mock('@lobehub/ui', () => ({
  Avatar: ({ avatar }: { avatar?: string }) => <img alt="avatar" src={avatar} />,
  Block: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, type }: { children?: ReactNode; type?: string }) => (
    <span data-type={type}>{children}</span>
  ),
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button data-loading={String(Boolean(loading))} {...props}>
      {children}
    </button>
  ),
}));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

const snapshot = (): AdminDefaultAgentSnapshot =>
  ({
    detail: {
      identity: { currentVersionId: 'version-1', id: 'agent-inbox' },
      versions: [
        {
          config: { avatar: '🤖', backgroundColor: '#222' },
          dependencySnapshot: { model: { modelKey: 'gpt-4o-mini', providerKey: 'openai' } },
          id: 'version-1',
        },
      ],
    },
    item: {
      displayName: 'Company assistant',
      identity: { currentVersionId: 'version-1', id: 'agent-inbox', status: 'published' },
      publishedVersion: '1.2.0',
    },
  }) as never;

const renderSection = (over: Partial<DefaultAgentSectionProps> = {}) =>
  render(
    <DefaultAgentSection
      canProvision
      canEdit={false}
      error={undefined}
      provisionFailed={false}
      provisioning={false}
      snapshot={snapshot()}
      onEdit={vi.fn()}
      onProvisionRetry={vi.fn()}
      onRetry={vi.fn()}
      {...over}
    />,
  );

describe('DefaultAgentSection', () => {
  it('renders the assistant without a version anywhere on the card', () => {
    renderSection();

    expect(screen.getByText('Company assistant')).toBeTruthy();
    // Avatar and model still come from the current version…
    expect(screen.getByAltText('avatar').getAttribute('src')).toBe('🤖');
    expect(screen.getByText('openai · gpt-4o-mini')).toBeTruthy();
    // …but saving IS publishing, so there is no version for an admin to reason about.
    expect(screen.queryByText('1.2.0')).toBeNull();
  });

  it('says the default is being prepared instead of offering a takeover step', () => {
    renderSection({ snapshot: null });

    expect(screen.getByText('agentCatalog.defaultAgent.preparing')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('owns the failure of the automatic initialization, with a retry', () => {
    const onProvisionRetry = vi.fn();
    renderSection({ onProvisionRetry, provisionFailed: true, snapshot: null });

    expect(screen.getByText('agentCatalog.defaultAgent.provision.error')).toBeTruthy();
    fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
    expect(onProvisionRetry).toHaveBeenCalledOnce();
  });

  it('keeps the failure on screen while the retry runs', () => {
    renderSection({ provisionFailed: true, provisioning: true, snapshot: null });

    expect(screen.getByText('agentCatalog.defaultAgent.provision.error')).toBeTruthy();
    expect(screen.getByText('agentCatalog.dependency.retry').getAttribute('data-loading')).toBe(
      'true',
    );
  });

  // `canProvision` is the whole create + publish + assign compound, so this is also the operator
  // who may create ordinary assistants but not the default one: no retry, nothing in flight.
  it('points an operator who cannot initialize the default at someone who can', () => {
    renderSection({ canProvision: false, snapshot: null });

    expect(screen.getByText('agentCatalog.defaultAgent.provision.readOnly')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never claims there is no default while the pointer read has not settled', () => {
    renderSection({ snapshot: undefined });
    expect(screen.getByText('agentCatalog.defaultAgent.loading')).toBeTruthy();

    renderSection({ error: new Error('offline'), snapshot: undefined });
    expect(screen.getAllByText('agentCatalog.defaultAgent.loadError').length).toBeGreaterThan(0);
    expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
  });
});
