/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TruncationNotice from './TruncationNotice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

describe('TruncationNotice', () => {
  it('renders the truncation notice when finishReason is length', () => {
    render(<TruncationNotice finishReason="length" />);

    expect(
      screen.getByText('messageAction.truncated · messageAction.truncatedHint'),
    ).toBeInTheDocument();
  });

  it('renders nothing for a complete stop', () => {
    const { container } = render(<TruncationNotice finishReason="stop" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a finish reason', () => {
    const { container } = render(<TruncationNotice />);

    expect(container).toBeEmptyDOMElement();
  });
});
