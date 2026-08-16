/**
 * @vitest-environment happy-dom
 */
import { type MessageModerationMetadata } from '@lobechat/types';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ModerationNotice from './ModerationNotice';

const getModelCardMock = vi.hoisted(() =>
  vi.fn(() => undefined as { displayName?: string } | undefined),
);

vi.mock('@lobehub/ui/base-ui', () => ({
  // Base UI renders tooltip content lazily in a portal on hover, which happy-dom cannot drive
  // deterministically. Rendering `title` inline asserts the actual content wiring instead.
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <div>
      {children}
      <span data-testid="tooltip-title">{title}</span>
    </div>
  ),
}));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    getModelCard:
      (...args: unknown[]) =>
      () =>
        getModelCardMock(...(args as [])),
  },
  useAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'model' in options
        ? `${key}:${options.model}`
        : options && 'category' in options
          ? `${key}:${options.category}`
          : key,
  }),
}));

const downgrade: MessageModerationMetadata = {
  action: 'downgrade',
  model: 'safe-model',
  originalModel: 'gpt-4o',
  originalProvider: 'openai',
  provider: 'safe-provider',
};

afterEach(() => {
  cleanup();
  getModelCardMock.mockReset();
  getModelCardMock.mockReturnValue(undefined);
});

describe('ModerationNotice', () => {
  it('renders the human model display name when the catalog knows the model', () => {
    getModelCardMock.mockReturnValue({ displayName: 'Safe Model 1.0' });

    render(<ModerationNotice moderation={downgrade} />);

    expect(screen.getByText('moderation.downgraded:Safe Model 1.0')).toBeInTheDocument();
  });

  it('falls back to the raw model id for an unknown model', () => {
    render(<ModerationNotice moderation={downgrade} />);

    expect(screen.getByText('moderation.downgraded:safe-model')).toBeInTheDocument();
  });

  it('renders nothing without moderation metadata', () => {
    const { container } = render(<ModerationNotice />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a non-downgrade action', () => {
    const { container } = render(
      <ModerationNotice moderation={{ ...downgrade, action: 'block' } as never} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the line when the category is unknown to this client build', () => {
    render(<ModerationNotice moderation={{ ...downgrade, category: 'brand_new' }} />);

    expect(screen.getByText('moderation.downgraded:safe-model')).toBeInTheDocument();
  });

  it('puts the hit category label in the tooltip content', () => {
    render(<ModerationNotice moderation={{ ...downgrade, category: 'jailbreak' }} />);

    expect(screen.getByTestId('tooltip-title')).toHaveTextContent(
      'moderation.categoryLabel:moderation.category.jailbreak',
    );
  });

  it('renders no tooltip at all when the category is absent', () => {
    render(<ModerationNotice moderation={downgrade} />);

    expect(screen.queryByTestId('tooltip-title')).not.toBeInTheDocument();
  });

  describe('admin downgradeMessage override', () => {
    it('renders the admin copy instead of the locale default', () => {
      render(
        <ModerationNotice
          moderation={{ ...downgrade, message: 'Company policy: this reply was rerouted.' }}
        />,
      );

      expect(screen.getByText('Company policy: this reply was rerouted.')).toBeInTheDocument();
      expect(screen.queryByText(/^moderation\.downgraded/)).not.toBeInTheDocument();
    });

    it('substitutes every {{model}} placeholder with the display name', () => {
      getModelCardMock.mockReturnValue({ displayName: 'Safe Model 1.0' });

      render(
        <ModerationNotice
          moderation={{ ...downgrade, message: '{{model}} answered — ask again for {{model}}.' }}
        />,
      );

      expect(
        screen.getByText('Safe Model 1.0 answered — ask again for Safe Model 1.0.'),
      ).toBeInTheDocument();
    });

    it('treats a display name containing regex replacement patterns literally', () => {
      // `String.replaceAll(search, string)` would expand `$&` / `$`` / `$'` in the replacement and
      // re-inject the surrounding text; the function replacer keeps the name literal.
      getModelCardMock.mockReturnValue({ displayName: "Model $& $` $' v2" });

      render(
        <ModerationNotice moderation={{ ...downgrade, message: 'switched to {{model}} now' }} />,
      );

      expect(screen.getByText("switched to Model $& $` $' v2 now")).toBeInTheDocument();
    });

    it('falls back to the locale default for a blank override', () => {
      render(<ModerationNotice moderation={{ ...downgrade, message: '   ' }} />);

      expect(screen.getByText('moderation.downgraded:safe-model')).toBeInTheDocument();
    });

    it('renders markup-looking admin text literally, never as HTML', () => {
      const hostile = '<img src=x onerror="alert(1)"> <b>bold</b> {{model}}';

      const { container } = render(
        <ModerationNotice moderation={{ ...downgrade, message: hostile }} />,
      );

      expect(
        screen.getByText('<img src=x onerror="alert(1)"> <b>bold</b> safe-model'),
      ).toBeInTheDocument();
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('b')).toBeNull();
    });

    it('does not let i18next interpolate other placeholders in the admin text', () => {
      render(
        <ModerationNotice
          moderation={{ ...downgrade, message: 'switched to {{model}} ({{nope}})' }}
        />,
      );

      // `{{nope}}` stays verbatim — the override never goes through i18next.
      expect(screen.getByText('switched to safe-model ({{nope}})')).toBeInTheDocument();
    });
  });
});
