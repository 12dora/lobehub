// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSystemStatus } from '@/enterprise/client/services/adminSystem';

import { DependencyGrid } from './SystemOverview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  m: { span: ({ children }: { children?: ReactNode }) => <span>{children}</span> },
  useReducedMotion: () => true,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: () => null,
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => <span />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

const health = {
  errorCategory: null,
  lastCheckedAt: new Date('2026-08-21T00:00:00.000Z'),
  status: 'healthy' as const,
};

const status = (sandbox?: AdminSystemStatus['dependencies']['sandbox']): AdminSystemStatus =>
  ({
    build: { gitSha: 'abc1234', version: '1.0.0' },
    dependencies: {
      database: health,
      keyManagement: health,
      mail: health,
      objectStorage: health,
      redis: health,
      ...(sandbox ? { sandbox } : {}),
    },
    domains: [],
    featureFlags: {
      databaseOidc: false,
      managedAgents: true,
      managedAi: true,
      managedConnectors: true,
      managedSkills: true,
      platformAdmin: true,
      runtimeBranding: true,
      settingsPolicy: true,
    },
    instanceStatus: health,
    jobs: {
      active: 0,
      completed: 0,
      errorCategory: null,
      failed: 0,
      status: 'healthy',
      total: 0,
    },
    oidc: {
      activeRevision: null,
      configured: false,
      pendingRestart: false,
      source: 'disabled',
      status: 'disabled',
    },
    recentPublishFailures: { count: 0, errorCategory: null, items: [], status: 'healthy' },
    snapshotAt: new Date('2026-08-21T00:00:00.000Z'),
  }) as AdminSystemStatus;

describe('DependencyGrid sandbox row', () => {
  it('hides the sandbox row when the probe is omitted', () => {
    render(<DependencyGrid status={status()} />);
    expect(screen.queryByText('system.dependencies.sandbox')).toBeNull();
  });

  it('shows daemon, image, and container counts for a local sandbox probe', () => {
    render(
      <DependencyGrid
        status={status({
          activeContainers: 2,
          daemonReachable: true,
          errorCategory: null,
          imagePresent: true,
          lastCheckedAt: new Date('2026-08-21T00:00:00.000Z'),
          maxContainers: 8,
          status: 'healthy',
        })}
      />,
    );

    expect(screen.getByText('system.dependencies.sandbox')).toBeTruthy();
    expect(screen.getByText(/system.sandbox.containers/)).toBeTruthy();
    expect(screen.getByText(/system.sandbox.daemon/)).toBeTruthy();
    expect(screen.getByText(/system.sandbox.image/)).toBeTruthy();
  });
});
