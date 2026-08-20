/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagedResourceNotice } from './ManagedResourceNotice';

vi.mock(
  '@lobehub/ui',
  () =>
    new Proxy(
      { FluentEmoji: () => null },
      {
        // `then` must stay undefined: vitest awaits the mock factory's result, and a Proxy that
        // answers `'then' in ns` with a function looks like a thenable and never settles.
        get: (target, property: string) => {
          if (property === 'then') return undefined;
          if (property in target) return target[property as keyof typeof target];
          return ({ children }: { children?: ReactNode }) => <div>{children}</div>;
        },
        has: (_target, property) => property !== 'then',
      },
    ),
);

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

describe('ManagedResourceNotice', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the community browse escape hatch for catalogs that stay browsable', () => {
    render(<ManagedResourceNotice resource="skills" />);

    expect(screen.getByText('managedResources.notice.back')).toBeInTheDocument();
    expect(screen.getByText('managedResources.notice.browse')).toBeInTheDocument();
  });

  it('drops the browse button for agents — every community "Add" is a denied create', () => {
    render(<ManagedResourceNotice resource="agents" />);

    expect(screen.getByText('managedResources.notice.back')).toBeInTheDocument();
    expect(screen.queryByText('managedResources.notice.browse')).not.toBeInTheDocument();
  });
});
