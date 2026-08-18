import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type AiProviderListItem, AiProviderSourceEnum } from '@/types/aiProvider';

import ProviderItem from './Item';

vi.mock('react-router', () => ({ useLocation: () => ({ pathname: '/admin/ai/providers' }) }));

vi.mock('@lobehub/icons', () => ({ ProviderIcon: () => null }));

vi.mock('@/components/Branding/ProductLogo', () => ({ ProductLogo: () => null }));

vi.mock('@/features/NavPanel/components/NavItem', () => ({
  default: ({ title }: { title: string }) => <span>{title}</span>,
}));

// The `providers` namespace ships a name key only for the handful of ids that opt in.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === 'chatgptweb.name' ? 'ChatGPT 网页版' : (options?.defaultValue ?? key),
  }),
}));

describe('ProviderItem', () => {
  it('names a builtin from its card, so a stale stored name cannot shadow it', () => {
    // The platform row was created while the card was still branded "SuperGrok"; the card
    // (and the panel beside this menu) says "Grok".
    render(
      <ProviderItem
        enabled
        id={'supergrok'}
        name={'SuperGrok'}
        source={AiProviderSourceEnum.Builtin}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('Grok')).toBeTruthy();
    expect(screen.queryByText('SuperGrok')).toBeNull();
  });

  it('still localizes the builtins the providers namespace opts in', () => {
    render(
      <ProviderItem
        enabled
        id={'chatgptweb'}
        name={'ChatGPT Web'}
        source={AiProviderSourceEnum.Builtin}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('ChatGPT 网页版')).toBeTruthy();
  });

  it('keeps a legacy custom row’s name when the source column is empty', () => {
    // `source` is nullable in the database: rows written before the column existed carry
    // nothing, and reading that as "builtin" put the raw id in the sidebar.
    render(
      <ProviderItem
        enabled
        id={'internal_proxy'}
        name={'Internal Gateway'}
        source={undefined as unknown as AiProviderListItem['source']}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('Internal Gateway')).toBeTruthy();
    expect(screen.queryByText('internal_proxy')).toBeNull();
  });

  it('still names a builtin id from its card when the source column is empty', () => {
    render(
      <ProviderItem
        enabled
        id={'supergrok'}
        name={'SuperGrok'}
        source={undefined as unknown as AiProviderListItem['source']}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('Grok')).toBeTruthy();
    expect(screen.queryByText('SuperGrok')).toBeNull();
  });

  it('echoes a custom provider’s own name — nobody else authors it', () => {
    render(
      <ProviderItem
        enabled
        id={'internal_proxy'}
        name={'Internal Gateway'}
        source={AiProviderSourceEnum.Custom}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('Internal Gateway')).toBeTruthy();
  });
});
