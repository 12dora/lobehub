/**
 * Cached conversation evidence remains visible when detail revalidation fails.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationTopicPage from './ConversationTopicPage';

const evidence = vi.hoisted(() => ({
  detailListeners: new Set<() => void>(),
  detailMutate: vi.fn(),
  detailSnapshot: {
    data: {
      agentId: 'agent-1',
      contentAccessMode: 'metadata_only' as const,
      model: 'cached-model',
      provider: 'cached-provider',
      title: 'Cached topic',
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    },
    error: new Error('detail refresh failed') as unknown,
    isLoading: false,
    isValidating: false,
  },
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: React.ReactNode; message?: React.ReactNode }) => (
    <div role="alert">
      {message}
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Skeleton: () => <div data-testid="skeleton" />,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Switch: () => <input type="checkbox" />,
  toast: { error: (...args: unknown[]) => evidence.toastError(...args) },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: ['platform_audit:conversation_read:all'],
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', async () => {
  const React = await import('react');
  return {
    useFetchAuditConversation: () => {
      const snapshot = React.useSyncExternalStore(
        (listener) => {
          evidence.detailListeners.add(listener);
          return () => evidence.detailListeners.delete(listener);
        },
        () => evidence.detailSnapshot,
        () => evidence.detailSnapshot,
      );
      return { ...snapshot, mutate: evidence.detailMutate };
    },
    useFetchAuditConversationMessages: () => ({
      data: {
        contentAccessMode: 'metadata_only',
        items: [
          {
            content: 'Cached message evidence',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
            hasContent: true,
            id: 'message-1',
            role: 'user',
          },
        ],
        nextCursor: null,
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    }),
    useFetchAuditPolicy: () => ({
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    }),
  };
});

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    banner,
    children,
    title,
  }: {
    banner?: React.ReactNode;
    children?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {banner}
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DangerConfirm', () => ({
  openDangerConfirm: vi.fn(),
}));

vi.mock('./ContentAccessDisabledState', () => ({
  default: () => <div data-testid="content-disabled">disabled</div>,
}));

const emitDetail = () => {
  for (const listener of evidence.detailListeners) listener();
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/audit/conversations/user-1/topics/topic-1']}>
      <Routes>
        <Route
          element={<ConversationTopicPage />}
          path="/admin/audit/conversations/:userId/topics/:topicId"
        />
      </Routes>
    </MemoryRouter>,
  );

describe('ConversationTopicPage', () => {
  beforeEach(() => {
    evidence.detailMutate.mockReset();
    evidence.toastError.mockReset();
    evidence.detailSnapshot = {
      data: {
        agentId: 'agent-1',
        contentAccessMode: 'metadata_only',
        model: 'cached-model',
        provider: 'cached-provider',
        title: 'Cached topic',
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      error: new Error('detail refresh failed'),
      isLoading: false,
      isValidating: false,
    };
  });

  it('preserves stale evidence and exposes an episode-deduped detail warning with retry', () => {
    renderPage();

    expect(screen.getByText('Cached topic')).toBeTruthy();
    expect(screen.getByText('Cached message evidence')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'audit.conversations.topic.detailUnavailable',
    );
    expect(evidence.toastError).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('audit.shared.retryMissingSections'));
    expect(evidence.detailMutate).toHaveBeenCalledTimes(1);

    act(() => {
      evidence.detailSnapshot = {
        ...evidence.detailSnapshot,
        error: new Error('same failed revalidation episode'),
      };
      emitDetail();
    });
    expect(evidence.toastError).toHaveBeenCalledTimes(1);

    act(() => {
      evidence.detailSnapshot = { ...evidence.detailSnapshot, error: undefined };
      emitDetail();
    });
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      evidence.detailSnapshot = {
        ...evidence.detailSnapshot,
        error: new Error('next failed revalidation episode'),
      };
      emitDetail();
    });
    expect(evidence.toastError).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Cached message evidence')).toBeTruthy();
  });

  it('keeps provider and model ids model-bank cannot describe', () => {
    const { container } = renderPage();

    expect(container.textContent).toContain('cached-provider · cached-model · agent-1');
  });
});
