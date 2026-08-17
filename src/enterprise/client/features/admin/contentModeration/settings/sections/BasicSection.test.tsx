// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import {
  MODERATION_BLOCK_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX,
  type ModerationConfigView,
} from '../draft';
import BasicSection from './BasicSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Text: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Checkbox: () => <input type="checkbox" />,
  Input: ({
    maxLength,
    onChange,
    value,
  }: {
    maxLength?: number;
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <input
      aria-label="downgrade-message"
      maxLength={maxLength}
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  Select: () => <select />,
  Switch: () => <input type="checkbox" />,
  TextArea: ({
    maxLength,
    onChange,
    value,
  }: {
    maxLength?: number;
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <textarea
      aria-label="block-message"
      maxLength={maxLength}
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
}));
vi.mock('../SettingsSection', () => ({
  default: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock('../Field', () => ({
  default: ({
    children,
    extra,
    hint,
  }: {
    children?: ReactNode;
    extra?: ReactNode;
    hint?: ReactNode;
  }) => (
    <div>
      {children}
      {hint}
      {extra}
    </div>
  ),
}));
vi.mock('../ModelSelect', () => ({ default: () => <div /> }));

const renderSection = (messages: Partial<ModerationConfigView['messages']> = {}) => {
  const config = {
    ...createDefaultContentModerationConfig(),
    messages: { ...createDefaultContentModerationConfig().messages, ...messages },
  } as unknown as ModerationConfigView;
  const onPatch = vi.fn();
  const utils = render(
    <BasicSection
      catalog={[]}
      config={config}
      disabled={false}
      onModeChange={vi.fn()}
      onPatch={onPatch}
    />,
  );
  return { ...utils, config, onPatch };
};

describe('BasicSection message contracts', () => {
  it('caps both inputs at their contract length', () => {
    renderSection();
    expect(screen.getByLabelText('block-message').getAttribute('maxlength')).toBe(
      String(MODERATION_BLOCK_MESSAGE_MAX),
    );
    // The downgrade notice travels on a response header, so its cap is far tighter.
    expect(screen.getByLabelText('downgrade-message').getAttribute('maxlength')).toBe(
      String(MODERATION_DOWNGRADE_MESSAGE_MAX),
    );
  });

  it('shows a live character counter for each field', () => {
    renderSection({ blockMessage: 'abc', downgradeMessage: 'de' });
    expect(screen.getByTestId('block-message-counter').textContent).toContain(
      'contentModeration.settings.basic.charCount',
    );
    expect(screen.getByTestId('downgrade-message-counter').textContent).toContain(
      'contentModeration.settings.basic.charCount',
    );
  });

  it('truncates a paste that exceeds the cap instead of storing it', () => {
    const { onPatch } = renderSection();
    fireEvent.change(screen.getByLabelText('downgrade-message'), {
      target: { value: 'x'.repeat(MODERATION_DOWNGRADE_MESSAGE_MAX + 50) },
    });
    expect(onPatch.mock.calls[0][0].messages.downgradeMessage).toHaveLength(
      MODERATION_DOWNGRADE_MESSAGE_MAX,
    );
  });

  it('warns when a CJK notice is within the character cap but too heavy encoded', () => {
    renderSection({ downgradeMessage: '审'.repeat(MODERATION_DOWNGRADE_MESSAGE_MAX) });
    expect(screen.getByTestId('downgrade-message-heavy').textContent).toBe(
      'contentModeration.errors.downgradeMessageTooHeavy',
    );
  });

  it('stays quiet for a normal-length notice', () => {
    renderSection({ downgradeMessage: '该消息因内容审计已改用 {{model}} 回复' });
    expect(screen.queryByTestId('downgrade-message-heavy')).toBeNull();
  });
});
