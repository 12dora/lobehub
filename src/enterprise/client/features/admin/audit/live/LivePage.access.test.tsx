/**
 * Live access / pagination / F9 wiring — characterization against LivePage.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LivePage from './LivePage';

const MSG_LIMIT = 100;

const evidence = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    version: 0,
    permissions: ['platform_audit:conversation_read:all', 'platform_audit:read:all'] as string[],
    policy: { contentAccessMode: 'content_allowed' as string | undefined } as
      { contentAccessMode: string; redactionProfile?: string } | undefined,
    topics: {
      data: { items: [] as Array<{ id: string }>, nextCursor: null as string | null } as
        | {
            items: Array<{ id: string }>;
            nextCursor: string | null;
            redactionProfile?: string;
          }
        | undefined,
      error: undefined as unknown,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    },
    messages: {
      data: {
        contentAccessMode: 'content_allowed' as string,
        items: [] as Array<Record<string, unknown>>,
        nextCursor: null as string | null,
      } as
        | {
            contentAccessMode: string;
            items: Array<Record<string, unknown>>;
            nextCursor: string | null;
            redactionProfile?: string;
          }
        | undefined,
      error: undefined as unknown,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    },
    topicDetail: {
      data: undefined as
        | {
            agentId?: string | null;
            contentAccessMode?: string;
            createdAt?: Date;
            id?: string;
            model?: string | null;
            provider?: string | null;
            redactionProfile?: string;
            title?: string | null;
          }
        | undefined,
      error: undefined as unknown,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    },
    listConversationMessages: vi.fn(),
    listConversations: vi.fn(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      evidence.version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string; time?: string }) => {
      if (opts?.time != null) return `${k}:${opts.time}`;
      return opts?.defaultValue ?? k;
    },
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
    permissions: evidence.permissions,
    roles: [],
  }),
}));

vi.mock('../shared/format', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    formatAdminDateTime: (d: Date) => `T${d.getTime()}`,
  };
});

vi.mock('../hooks/useAdminAudit', async () => {
  const React = await import('react');
  const useTick = () =>
    React.useSyncExternalStore(
      (listener) => evidence.subscribe(listener),
      () => evidence.version,
      () => evidence.version,
    );
  return {
    useFetchAuditConversation: (_userId?: string, _topicId?: string, _enabled?: boolean) => {
      useTick();
      return {
        data: evidence.topicDetail.data,
        error: evidence.topicDetail.error,
        isLoading: evidence.topicDetail.isLoading,
        isValidating: evidence.topicDetail.isValidating,
        mutate: evidence.topicDetail.mutate,
      };
    },
    useFetchAuditConversationMessages: (
      _params: { topicId?: string; userId?: string },
      _enabled?: boolean,
    ) => {
      useTick();
      return {
        data: evidence.messages.data,
        error: evidence.messages.error,
        isLoading: evidence.messages.isLoading,
        isValidating: evidence.messages.isValidating,
        mutate: evidence.messages.mutate,
      };
    },
    useFetchAuditConversationsList: (_params: { userId?: string }, _enabled?: boolean) => {
      useTick();
      return {
        data: evidence.topics.data,
        error: evidence.topics.error,
        isLoading: evidence.topics.isLoading,
        isValidating: evidence.topics.isValidating,
        mutate: evidence.topics.mutate,
      };
    },
    useFetchAuditPolicy: () => {
      useTick();
      return {
        data: evidence.policy,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    },
  };
});

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: ({ value }: { value?: string }) => (
    <div data-testid="user-search" data-value={value ?? ''} />
  ),
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    banner,
    children,
    notice,
    toolbar,
    title,
  }: {
    banner?: ReactNode;
    children?: ReactNode;
    notice?: ReactNode;
    title?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
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
  default: ({
    hasMore,
    items,
    onLoadMore,
  }: {
    hasMore?: boolean;
    items?: Array<{ id: string }>;
    onLoadMore?: () => void;
  }) => (
    <div data-has-more={hasMore ? '1' : '0'} data-testid="topic-list">
      {(items ?? []).map((item) => (
        <div data-testid={`live-topic-${item.id}`} key={item.id}>
          {item.id}
        </div>
      ))}
      <button data-testid="load-more-topics" type="button" onClick={() => onLoadMore?.()}>
        load-more-topics
      </button>
    </div>
  ),
}));

vi.mock('./MessagePane', () => ({
  default: ({
    bodyHidden,
    hasOlder,
    messages,
    onLoadOlder,
    topic,
  }: {
    bodyHidden?: boolean;
    hasOlder?: boolean;
    messages?: Array<{ content?: string | null; id: string }>;
    onLoadOlder?: () => void;
    topic?: {
      agentId?: string | null;
      createdAt?: Date;
      id?: string;
      model?: string | null;
      provider?: string | null;
      title?: string | null;
    };
  }) => (
    <div
      data-body-hidden={bodyHidden ? '1' : '0'}
      data-has-older={hasOlder ? '1' : '0'}
      data-testid="message-pane"
      data-topic-id={topic?.id ?? ''}
    >
      {topic ? (
        <>
          <span data-testid="topic-title">{topic.title}</span>
          <span data-testid="topic-provider">{topic.provider}</span>
          <span data-testid="topic-model">{topic.model}</span>
          <span data-testid="topic-agent">{topic.agentId}</span>
          <a
            data-testid="topic-evidence-link"
            href={`/admin/audit/conversations/u1/topics/${topic.id}`}
          >
            open-evidence
          </a>
        </>
      ) : null}
      {(messages ?? []).map((m) => (
        <div data-content={m.content ?? ''} data-testid={`msg-${m.id}`} key={m.id}>
          {m.id}
        </div>
      ))}
      <button data-testid="load-older" type="button" onClick={() => onLoadOlder?.()}>
        load-older
      </button>
    </div>
  ),
}));

vi.mock('@/enterprise/client/services/adminAudit', () => ({
  adminAuditService: {
    listConversationMessages: (...args: unknown[]) => evidence.listConversationMessages(...args),
    listConversations: (...args: unknown[]) => evidence.listConversations(...args),
  },
}));

const msg = (id: string, content = `body-${id}`) => ({
  agentId: null,
  content,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  id,
  model: null,
  parentId: null,
  provider: null,
  role: 'user',
  sessionId: null,
  topicId: 't1',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  userId: 'u1',
});

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

const emit = async (patch?: () => void) => {
  await act(async () => {
    patch?.();
    evidence.emit();
  });
};

describe('LivePage access / feed characterization', () => {
  beforeEach(() => {
    evidence.version = 0;
    evidence.permissions = ['platform_audit:conversation_read:all', 'platform_audit:read:all'];
    evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'strict' };
    evidence.topics.data = { items: [], nextCursor: null, redactionProfile: 'strict' };
    evidence.topics.error = undefined;
    evidence.topics.isLoading = false;
    evidence.topics.isValidating = false;
    evidence.topics.mutate = vi.fn().mockResolvedValue(undefined);
    evidence.messages.data = {
      contentAccessMode: 'content_allowed',
      items: [msg('head-1')],
      nextCursor: 'c-older',
      redactionProfile: 'strict',
    };
    evidence.messages.error = undefined;
    evidence.messages.isLoading = false;
    evidence.messages.isValidating = false;
    evidence.messages.mutate = vi.fn().mockResolvedValue(undefined);
    evidence.topicDetail.data = undefined;
    evidence.topicDetail.error = undefined;
    evidence.topicDetail.isLoading = false;
    evidence.topicDetail.isValidating = false;
    evidence.topicDetail.mutate = vi.fn().mockResolvedValue(undefined);
    evidence.listConversationMessages.mockReset();
    evidence.listConversations.mockReset();
    evidence.listConversationMessages.mockResolvedValue({
      contentAccessMode: 'content_allowed',
      items: [msg('old-1')],
      nextCursor: null,
      redactionProfile: 'strict',
    });
  });

  it('keeps bodyHidden after head purge instead of falling back to stale policy.get', async () => {
    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    expect(screen.getByTestId('message-pane').getAttribute('data-body-hidden')).toBe('0');

    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'metadata_only',
        items: [msg('head-1')],
        nextCursor: 'c-older',
      };
    });

    expect(screen.getByTestId('message-pane').getAttribute('data-body-hidden')).toBe('1');

    // SWR head purged; policy snapshot still claims content is allowed.
    await emit(() => {
      evidence.messages.data = undefined;
    });

    expect(evidence.policy?.contentAccessMode).toBe('content_allowed');
    expect(screen.getByTestId('message-pane').getAttribute('data-body-hidden')).toBe('1');
    expect(screen.getByTestId('notice').textContent).toBe('audit.live.banner.metadataOnly');
    expect(screen.getByTestId('banner').textContent).toBe('');
  });

  it('purges older pages and SWR head when polled mode flips to metadata_only', async () => {
    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => {
      expect(screen.getByTestId('msg-old-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('msg-old-1').getAttribute('data-content')).toBe('body-old-1');

    evidence.messages.mutate.mockClear();

    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'metadata_only',
        items: [msg('head-1')],
        nextCursor: 'c-older',
      };
    });

    expect(screen.queryByTestId('msg-old-1')).not.toBeInTheDocument();
  });

  it('purges older pages and revalidates caches when redactionProfile tightens off → strict', async () => {
    evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'off' };
    evidence.topics.data = { items: [], nextCursor: null, redactionProfile: 'off' };
    evidence.messages.data = {
      contentAccessMode: 'content_allowed',
      items: [msg('head-1')],
      nextCursor: 'c-older',
      redactionProfile: 'off',
    };
    evidence.listConversationMessages.mockResolvedValue({
      contentAccessMode: 'content_allowed',
      items: [msg('old-1', 'sk-abcdefghijklmnopqrstuvwxyz012345')],
      nextCursor: null,
      redactionProfile: 'off',
    });

    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => {
      expect(screen.getByTestId('msg-old-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('msg-old-1').getAttribute('data-content')).toBe(
      'sk-abcdefghijklmnopqrstuvwxyz012345',
    );

    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'content_allowed',
        items: [msg('head-1')],
        nextCursor: 'c-older',
        redactionProfile: 'strict',
      };
    });

    expect(screen.queryByTestId('msg-old-1')).not.toBeInTheDocument();
  });

  it('purges cached raw bodies when messages stay off but topics/policy report strict', async () => {
    evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'off' };
    evidence.topics.data = { items: [], nextCursor: null, redactionProfile: 'off' };
    evidence.messages.data = {
      contentAccessMode: 'content_allowed',
      items: [msg('head-1')],
      nextCursor: 'c-older',
      redactionProfile: 'off',
    };
    evidence.listConversationMessages.mockResolvedValue({
      contentAccessMode: 'content_allowed',
      items: [msg('old-1', 'sk-abcdefghijklmnopqrstuvwxyz012345')],
      nextCursor: null,
      redactionProfile: 'off',
    });

    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => {
      expect(screen.getByTestId('msg-old-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('msg-old-1').getAttribute('data-content')).toBe(
      'sk-abcdefghijklmnopqrstuvwxyz012345',
    );

    await emit(() => {
      evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'strict' };
      evidence.topics.data = { items: [], nextCursor: null, redactionProfile: 'strict' };
    });

    expect(screen.queryByTestId('msg-old-1')).not.toBeInTheDocument();
  });

  it('discards an in-flight older page when access epoch advances mid-await', async () => {
    let resolvePage!: (value: {
      contentAccessMode: string;
      items: ReturnType<typeof msg>[];
      nextCursor: string | null;
    }) => void;
    evidence.listConversationMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    renderLive('/admin/audit/live?userId=u1&topicId=t1');
    fireEvent.click(screen.getByTestId('load-older'));

    await waitFor(() => {
      expect(evidence.listConversationMessages).toHaveBeenCalled();
    });

    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'metadata_only',
        items: [msg('head-1')],
        nextCursor: 'c-older',
      };
    });

    await act(async () => {
      resolvePage({
        contentAccessMode: 'content_allowed',
        items: [msg('old-secret', 'LEAKED')],
        nextCursor: null,
      });
    });

    expect(screen.queryByTestId('msg-old-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('LEAKED')).not.toBeInTheDocument();
  });

  it('shows a gap banner for a full disjoint head and clears older pages on reload', async () => {
    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => {
      expect(screen.getByTestId('msg-old-1')).toBeInTheDocument();
    });

    const disjointHead = Array.from({ length: MSG_LIMIT }, (_, i) => msg(`new-${i}`));
    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'content_allowed',
        items: disjointHead,
        nextCursor: 'c-2',
      };
    });

    expect(screen.getByText('audit.live.messages.gapWarning')).toBeInTheDocument();

    evidence.messages.mutate.mockClear();
    fireEvent.click(screen.getByText('audit.live.messages.reload'));

    expect(screen.queryByTestId('msg-old-1')).not.toBeInTheDocument();
    expect(screen.queryByText('audit.live.messages.gapWarning')).not.toBeInTheDocument();
    expect(evidence.messages.mutate).toHaveBeenCalled();
  });

  it('advances lastRefreshedAt only when every active feed settles without error', async () => {
    evidence.topics.isValidating = true;
    evidence.topics.data = undefined;
    evidence.messages.isValidating = true;

    renderLive('/admin/audit/live?userId=u1&topicId=t1');
    expect(screen.queryByText(/audit.live.filters.refreshed/)).toBeNull();

    await emit(() => {
      evidence.topics.isValidating = false;
      evidence.topics.data = { items: [], nextCursor: null };
    });
    expect(screen.queryByText(/audit.live.filters.refreshed/)).toBeNull();

    await emit(() => {
      evidence.messages.isValidating = false;
    });
    expect(screen.getByText(/audit.live.filters.refreshed/)).toBeInTheDocument();

    const stamp = screen.getByText(/audit.live.filters.refreshed/).textContent;

    fireEvent.click(screen.getByTestId('live-switch'));
    expect(screen.getByText('audit.live.filters.refreshNow')).toBeInTheDocument();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });

    evidence.topics.mutate.mockRejectedValueOnce(new Error('refresh failed'));
    fireEvent.click(screen.getByText('audit.live.filters.refreshNow'));

    await waitFor(() => {
      expect(evidence.topics.mutate).toHaveBeenCalled();
    });
    expect(screen.getByText(/audit.live.filters.refreshed/).textContent).toBe(stamp);
  });

  it('shows the disabled state without both permissions, and empty-guide when only audit-read is present', () => {
    evidence.permissions = [];
    const { unmount } = render(
      <RouterProvider
        router={createMemoryRouter([{ element: <LivePage />, path: '/admin/audit/live' }], {
          initialEntries: ['/admin/audit/live'],
        })}
      />,
    );
    expect(screen.getByTestId('content-disabled')).toBeInTheDocument();
    expect(screen.queryByText('audit.live.empty.noConversationPermission')).toBeNull();
    unmount();

    evidence.permissions = ['platform_audit:read:all'];
    renderLive('/admin/audit/live');
    expect(screen.queryByTestId('content-disabled')).not.toBeInTheDocument();
    expect(screen.getByText('audit.live.empty.noConversationPermission')).toBeInTheDocument();
  });

  it('does not commit topic detail metadata or the evidence link when the detail envelope is looser', () => {
    evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'strict' };
    evidence.topics.data = { items: [], nextCursor: null, redactionProfile: 'strict' };
    evidence.messages.data = {
      contentAccessMode: 'content_allowed',
      items: [msg('head-1')],
      nextCursor: null,
      redactionProfile: 'strict',
    };
    evidence.topicDetail.data = {
      agentId: 'agent-secret',
      contentAccessMode: 'content_allowed',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      id: 't1',
      model: 'secret-model',
      provider: 'secret-provider',
      redactionProfile: 'off',
      title: 'sk-abcdefghijklmnopqrstuvwxyz012345',
    };

    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    expect(screen.getByTestId('message-pane').getAttribute('data-topic-id')).toBe('');
    expect(screen.queryByTestId('topic-evidence-link')).toBeNull();
    expect(screen.queryByTestId('topic-title')).toBeNull();
    expect(screen.queryByTestId('topic-provider')).toBeNull();
    expect(screen.queryByTestId('topic-model')).toBeNull();
    expect(screen.queryByTestId('topic-agent')).toBeNull();
    expect(screen.queryByText('sk-abcdefghijklmnopqrstuvwxyz012345')).toBeNull();
    expect(screen.queryByText('secret-provider')).toBeNull();
    expect(screen.queryByText('secret-model')).toBeNull();
    expect(screen.queryByText('agent-secret')).toBeNull();
  });

  it('restarts load-older from the strict head cursor after a tightening reset', async () => {
    evidence.policy = { contentAccessMode: 'content_allowed', redactionProfile: 'off' };
    evidence.topics.data = {
      items: [{ id: 'topic-head' }],
      nextCursor: 't-c1',
      redactionProfile: 'off',
    };
    evidence.messages.data = {
      contentAccessMode: 'content_allowed',
      items: [msg('head-1')],
      nextCursor: 'c1',
      redactionProfile: 'off',
    };
    evidence.listConversationMessages.mockResolvedValue({
      contentAccessMode: 'content_allowed',
      items: [msg('old-1', 'sk-abcdefghijklmnopqrstuvwxyz012345')],
      nextCursor: 'c2',
      redactionProfile: 'off',
    });
    evidence.listConversations.mockResolvedValue({
      items: [{ id: 'topic-old' }],
      nextCursor: 't-c2',
      redactionProfile: 'off',
    });

    renderLive('/admin/audit/live?userId=u1&topicId=t1');

    fireEvent.click(screen.getByTestId('load-older'));
    fireEvent.click(screen.getByTestId('load-more-topics'));
    await waitFor(() => {
      expect(screen.getByTestId('msg-old-1')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(evidence.listConversations).toHaveBeenCalled();
    });
    expect(evidence.listConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'c1' }),
    );
    expect(evidence.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 't-c1' }),
    );

    await emit(() => {
      evidence.messages.data = {
        contentAccessMode: 'content_allowed',
        items: [msg('head-1')],
        nextCursor: 'c1',
        redactionProfile: 'strict',
      };
      evidence.topics.data = {
        items: [{ id: 'topic-head' }],
        nextCursor: 't-c1',
        redactionProfile: 'strict',
      };
    });

    expect(screen.queryByTestId('msg-old-1')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('message-pane').getAttribute('data-has-older')).toBe('1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('topic-list').getAttribute('data-has-more')).toBe('1');
    });

    evidence.listConversationMessages.mockClear();
    evidence.listConversations.mockClear();
    evidence.listConversationMessages.mockResolvedValue({
      contentAccessMode: 'content_allowed',
      items: [msg('old-1-strict')],
      nextCursor: 'c2',
      redactionProfile: 'strict',
    });
    evidence.listConversations.mockResolvedValue({
      items: [{ id: 'topic-old-strict' }],
      nextCursor: 't-c2',
      redactionProfile: 'strict',
    });

    fireEvent.click(screen.getByTestId('load-older'));
    fireEvent.click(screen.getByTestId('load-more-topics'));

    await waitFor(() => {
      expect(evidence.listConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'c1' }),
      );
    });
    await waitFor(() => {
      expect(evidence.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 't-c1' }),
      );
    });
    expect(evidence.listConversationMessages).not.toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'c2' }),
    );
    expect(evidence.listConversations).not.toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 't-c2' }),
    );
  });
});
