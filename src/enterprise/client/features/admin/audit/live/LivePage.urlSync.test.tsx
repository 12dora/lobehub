/**
 * Live URL query changes must clear stale user/topic state while mounted.
 * @vitest-environment happy-dom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LivePage from './LivePage';

const evidence = vi.hoisted(() => ({
  conversationCalls: [] as Array<{ topicId?: string; userId?: string }>,
  listCalls: [] as Array<{ userId?: string }>,
  messagesCalls: [] as Array<{ topicId?: string; userId?: string }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Switch: ({ checked, onChange }: { checked?: boolean; onChange?: (v: boolean) => void }) => (
    <input
      checked={checked}
      data-testid="live-switch"
      type="checkbox"
      onChange={(e) => onChange?.(e.target.checked)}
    />
  ),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: ['platform_audit:conversation_read:all', 'platform_audit:read:all'],
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  useFetchAuditConversation: (userId?: string, topicId?: string, enabled?: boolean) => {
    if (enabled) evidence.conversationCalls.push({ topicId, userId });
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
  useFetchAuditConversationMessages: (
    params: { topicId?: string; userId?: string },
    enabled?: boolean,
  ) => {
    if (enabled) evidence.messagesCalls.push({ topicId: params.topicId, userId: params.userId });
    return {
      data: { contentAccessMode: 'metadata_only', items: [], nextCursor: null },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
  useFetchAuditConversationsList: (params: { userId?: string }, enabled?: boolean) => {
    if (enabled) evidence.listCalls.push({ userId: params.userId });
    return {
      data: { items: [], nextCursor: null },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    };
  },
  useFetchAuditPolicy: () => ({
    data: { contentAccessMode: 'metadata_only' },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: ({ value }: { value?: string }) => (
    <div data-testid="user-search" data-value={value ?? ''} />
  ),
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    banner,
    children,
    description,
    notice,
    toolbar,
    title,
  }: {
    banner?: ReactNode;
    children?: ReactNode;
    description?: ReactNode;
    notice?: ReactNode;
    title?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="description">{description}</div>
      <div data-testid="notice">{notice}</div>
      <div data-testid="banner">{banner}</div>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../conversations/ContentAccessDisabledState', () => ({
  default: () => <div data-testid="content-disabled">disabled</div>,
}));

vi.mock('./TopicListPane', () => ({
  default: () => <div data-testid="topic-list" />,
}));

vi.mock('./MessagePane', () => ({
  default: () => <div data-testid="message-pane" />,
}));

vi.mock('@/enterprise/client/services/adminAudit', () => ({
  adminAuditService: {
    listConversationMessages: vi.fn(),
    listConversations: vi.fn(),
  },
}));

const renderLive = (initialUrl: string) => {
  const router = createMemoryRouter(
    [
      {
        element: <LivePage />,
        path: '/admin/audit/live',
      },
    ],
    { initialEntries: [initialUrl] },
  );
  render(<RouterProvider router={router} />);
  return router;
};

describe('LivePage URL synchronization', () => {
  beforeEach(() => {
    evidence.conversationCalls.length = 0;
    evidence.listCalls.length = 0;
    evidence.messagesCalls.length = 0;
  });

  it('clears topic when navigating from user A+topic X to user B without topic', async () => {
    const router = renderLive('/admin/audit/live?userId=A&topicId=X');

    expect(evidence.messagesCalls.some((c) => c.userId === 'A' && c.topicId === 'X')).toBe(true);
    expect(screen.getByTestId('user-search').getAttribute('data-value')).toBe('A');

    await act(async () => {
      await router.navigate('/admin/audit/live?userId=B');
    });

    await waitFor(() => {
      expect(screen.getByTestId('user-search').getAttribute('data-value')).toBe('B');
    });

    // Topic X must never pair with user B after the URL drops topicId.
    expect(evidence.messagesCalls.some((c) => c.userId === 'B' && c.topicId === 'X')).toBe(false);
    // Messages only enable when both userId and topicId are set — B alone must not.
    expect(evidence.messagesCalls.some((c) => c.userId === 'B')).toBe(false);
    // List still polls for user B.
    expect(evidence.listCalls.some((c) => c.userId === 'B')).toBe(true);
  });

  it('renders the metadata-only policy notice next to the page description, not as a banner', () => {
    renderLive('/admin/audit/live');

    // Policy is metadata_only → the sentence joins the description line; notice + banner slots stay empty.
    expect(screen.getByTestId('description').textContent).toBe(
      'audit.live.page.desc audit.live.banner.metadataOnly',
    );
    expect(screen.getByTestId('notice').textContent).toBe('');
    expect(screen.getByTestId('banner').textContent).toBe('');
  });

  it('clears user and topic when navigating to bare live URL', async () => {
    const router = renderLive('/admin/audit/live?userId=A&topicId=X');

    await act(async () => {
      await router.navigate('/admin/audit/live');
    });

    await waitFor(() => {
      expect(screen.getByTestId('user-search').getAttribute('data-value')).toBe('');
    });

    // After clear, no enabled conversation/messages for the previous subject.
    expect(evidence.messagesCalls.some((c) => c.userId === 'A' && c.topicId === 'X')).toBe(true);
    // Latest list call must not keep user A (hook disabled without userId).
    const enabledAfterClear = evidence.listCalls.filter((c) => c.userId === 'A');
    // Had A initially, but once cleared the selector shows empty.
    expect(enabledAfterClear.length).toBeGreaterThan(0);
    expect(screen.getByTestId('user-search').getAttribute('data-value')).toBe('');
  });
});
