import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OAuthExpiredError, { readErrorProviderId } from './OAuthExpiredError';

const mocks = vi.hoisted(() => ({
  deleteMessage: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@lobehub/icons', () => ({
  ProviderIcon: ({ provider }: { provider?: string }) => (
    <span data-provider={provider ?? ''} data-testid={'provider-icon'} />
  ),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => mocks.navigate,
}));

vi.mock('@/hooks/useProviderName', () => ({
  // Mirrors the real hook: an unknown id echoes back, and nothing echoes back nothing.
  useProviderName: (provider?: string) => provider,
}));

vi.mock('../store', () => ({
  useConversationStore: (selector: (state: unknown) => unknown) =>
    selector({ deleteMessage: mocks.deleteMessage }),
}));

vi.mock('./BaseErrorForm', () => ({
  default: ({ action, avatar, title }: Record<string, unknown>) => (
    <div>
      {avatar as never}
      <span data-testid={'title'}>{title as never}</span>
      {action as never}
    </div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const render = (ui: ReactElement) =>
  rtlRender(<MotionProvider motion={motion}>{ui}</MotionProvider>);

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.deleteMessage.mockReset();
});

describe('readErrorProviderId', () => {
  it('accepts a plain provider slug', () => {
    expect(readErrorProviderId({ provider: 'chatgptweb' })).toBe('chatgptweb');
    expect(readErrorProviderId({ provider: '  github_copilot-1  ' })).toBe('github_copilot-1');
  });

  it('accepts the dotted keys the catalog really uses', () => {
    // Namespaced provider keys are part of the contract; rejecting them stranded the card on
    // the provider list for exactly the providers it was meant to point at.
    expect(readErrorProviderId({ provider: 'azure.gpt-4o' })).toBe('azure.gpt-4o');
    expect(readErrorProviderId({ provider: 'a.b.c' })).toBe('a.b.c');
  });

  it.each([
    ['a non-object body', 'chatgptweb'],
    ['a missing body', undefined],
    ['a null body', null],
  ])('returns undefined for %s', (_label, body) => {
    expect(readErrorProviderId(body)).toBeUndefined();
  });

  it.each([
    ['an object provider', { provider: { id: 'chatgptweb' } }],
    ['a numeric provider', { provider: 42 }],
    ['an empty provider', { provider: '   ' }],
    ['a path traversal', { provider: '../../admin' }],
    ['a slashed path', { provider: 'settings/provider' }],
    ['an absolute url', { provider: 'https://evil.test' }],
    ['an over-long value', { provider: 'a'.repeat(65) }],
    // Catalog ids are lowercase, and a leading symbol is how a relative path starts.
    ['an uppercase id', { provider: 'ChatGPTWeb' }],
    ['a leading dot', { provider: '.hidden' }],
    ['a leading dash', { provider: '-flag' }],
    ['a leading underscore', { provider: '_private' }],
    ['a dotted traversal', { provider: '..' }],
  ])('rejects %s', (_label, body) => {
    expect(readErrorProviderId(body)).toBeUndefined();
  });
});

describe('OAuthExpiredError', () => {
  it('navigates to the provider settings page and drops the error message', () => {
    render(<OAuthExpiredError id={'msg-1'} provider={'chatgptweb'} />);

    fireEvent.click(screen.getByText('unlock.oauthExpired.action'));

    expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider/chatgptweb');
    expect(mocks.deleteMessage).toHaveBeenCalledWith('msg-1');
  });

  it('falls back to the provider list when the id is malformed', () => {
    // A path-like value must never become a path segment: the card is reachable from an
    // untyped error body, so the only safe destination is the list the user can fix from.
    render(<OAuthExpiredError id={'msg-2'} provider={'../../admin'} />);

    fireEvent.click(screen.getByText('unlock.oauthExpired.action'));

    expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider/all');
    expect(screen.getByTestId('provider-icon').getAttribute('data-provider')).toBe('');
  });

  it('falls back to the provider list when no provider is reported', () => {
    render(<OAuthExpiredError id={'msg-3'} />);

    fireEvent.click(screen.getByText('unlock.oauthExpired.action'));

    expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider/all');
  });

  it('navigates to a dotted provider id instead of the list', () => {
    render(<OAuthExpiredError id={'msg-4'} provider={'azure.gpt-4o'} />);

    fireEvent.click(screen.getByText('unlock.oauthExpired.action'));

    expect(mocks.navigate).toHaveBeenCalledWith('/settings/provider/azure.gpt-4o');
  });

  it('names the provider generically when the id is unusable', () => {
    // Without a fallback label the interpolation collapses and the card reads "Reconnect ".
    render(<OAuthExpiredError id={'msg-5'} provider={'../../admin'} />);

    expect(screen.getByTestId('title').textContent).toBe(
      'unlock.oauthExpired.title:{"name":"unlock.oauthExpired.genericProvider"}',
    );
  });

  it('names the provider itself when the id is usable', () => {
    render(<OAuthExpiredError id={'msg-6'} provider={'chatgptweb'} />);

    expect(screen.getByTestId('title').textContent).toBe(
      'unlock.oauthExpired.title:{"name":"chatgptweb"}',
    );
  });
});
