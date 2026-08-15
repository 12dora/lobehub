/**
 * XC-ANIM-03: per-message entrance must set `initial` on the first render of a tail append.
 * framer captures initial once at mount (useConstant) — post-commit enterIds was inert.
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type * as ReactNamespace from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminAuditConversationDetail,
  AdminAuditConversationMessage,
} from '@/enterprise/client/services/adminAudit';

import MessagePane from './MessagePane';

const motionInitials = vi.hoisted(() => [] as unknown[]);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Skeleton: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('motion/react', () => {
  const React = require('react') as typeof ReactNamespace;
  const M = ({ children, initial, ...rest }: { children?: ReactNode; initial?: unknown }) => {
    motionInitials.push(initial);
    return React.createElement('div', rest, children);
  };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
    m: { div: M },
    useReducedMotion: () => false,
  };
});

vi.mock('./MessageBubble', () => ({
  default: ({ message }: { message: AdminAuditConversationMessage }) => (
    <div data-testid={`bubble-${message.id}`}>{message.id}</div>
  ),
}));

const topic = {
  agentId: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  id: 'topic-1',
  model: 'gpt',
  provider: 'openai',
  title: 't',
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  userId: 'u1',
} as AdminAuditConversationDetail;

const msg = (id: string, createdAt: string): AdminAuditConversationMessage =>
  ({
    content: id,
    createdAt: new Date(createdAt),
    hasContent: true,
    id,
    role: 'user',
  }) as AdminAuditConversationMessage;

const isEntrance = (initial: unknown) =>
  Boolean(
    initial &&
    typeof initial === 'object' &&
    (initial as { opacity?: number }).opacity === 0 &&
    (initial as { y?: number }).y === 6,
  );

const renderPane = (messages: AdminAuditConversationMessage[]) =>
  render(
    <MemoryRouter>
      <MessagePane
        bodyHidden={false}
        hasOlder={false}
        messages={messages}
        topic={topic}
        userId="u1"
        onLoadOlder={() => {}}
      />
    </MemoryRouter>,
  );

describe('MessagePane entrance (XC-ANIM-03)', () => {
  beforeEach(() => {
    motionInitials.length = 0;
  });

  it('passes initial opacity/y on the first render of a genuine tail append', () => {
    const m1 = msg('m1', '2024-01-01T00:00:00Z');
    const m2 = msg('m2', '2024-01-01T00:01:00Z');
    const m3 = msg('m3', '2024-01-01T00:02:00Z');

    const { rerender } = renderPane([m1, m2]);

    expect(screen.getByTestId('bubble-m1')).toBeInTheDocument();
    expect(screen.getByTestId('bubble-m2')).toBeInTheDocument();

    // First paint must not request entrance.
    expect(motionInitials.filter(isEntrance)).toHaveLength(0);
    motionInitials.length = 0;

    rerender(
      <MemoryRouter>
        <MessagePane
          bodyHidden={false}
          hasOlder={false}
          messages={[m1, m2, m3]}
          topic={topic}
          userId="u1"
          onLoadOlder={() => {}}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('bubble-m3')).toBeInTheDocument();
    // Newly mounted m.div for the tail append must receive initial on its first render.
    expect(motionInitials.filter(isEntrance).length).toBeGreaterThanOrEqual(1);
  });

  it('does not animate first paint of a stream', () => {
    renderPane([msg('m1', '2024-01-01T00:00:00Z')]);

    expect(motionInitials.filter(isEntrance)).toHaveLength(0);
  });

  it('names the provider in the topic header, keeping a model id model-bank cannot describe', () => {
    const { container } = renderPane([msg('m1', '2024-01-01T00:00:00Z')]);

    expect(container.textContent).toContain('OpenAI · gpt');
  });
});
