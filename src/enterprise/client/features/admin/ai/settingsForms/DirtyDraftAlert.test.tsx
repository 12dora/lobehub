import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import DirtyDraftAlert from './DirtyDraftAlert';

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('DirtyDraftAlert', () => {
  it('renders guidance title and settings-policy link target', () => {
    render(
      <MemoryRouter>
        <DirtyDraftAlert />
      </MemoryRouter>,
    );

    expect(screen.getByText('aiSettingsDefaults.dirtyDraft.title')).toBeInTheDocument();
    expect(screen.getByText('aiSettingsDefaults.dirtyDraft.desc')).toBeInTheDocument();
  });
});
