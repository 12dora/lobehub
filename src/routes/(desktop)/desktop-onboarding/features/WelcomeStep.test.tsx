import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import WelcomeStep from './WelcomeStep';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en-US' }, t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({ cssVar: new Proxy({}, { get: () => '#000' }) }));

vi.mock('@lobehub/ui', () => ({
  Block: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/awesome', () => ({
  TypewriterEffect: ({ sentences }: { sentences: string[] }) => <span>{sentences[0]}</span>,
}));

vi.mock('@lobehub/ui/chat', () => ({ LoadingDots: () => null }));

vi.mock('antd', () => ({ Steps: () => null }));

vi.mock('@/components/Branding', () => ({ ProductLogo: () => null }));

vi.mock('@/hooks/useDefaultInboxDisplayName', () => ({
  useDefaultInboxDisplayName: () => 'Lobe',
}));

const initialUserStoreState = useUserStore.getState();

afterEach(() => {
  cleanup();
  useUserStore.setState(initialUserStoreState, true);
  vi.clearAllMocks();
});

describe('WelcomeStep', () => {
  it('advances without opting the user into telemetry', () => {
    const onNext = vi.fn();
    const updateGeneralConfig = vi.fn();
    useUserStore.setState({ updateGeneralConfig });

    render(<WelcomeStep onNext={onNext} />);
    fireEvent.click(screen.getByText('telemetry.next'));

    // Consent belongs to the later data-mode step; a welcome screen must not opt anyone in.
    expect(updateGeneralConfig).not.toHaveBeenCalled();
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
