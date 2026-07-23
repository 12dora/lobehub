// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AiProviderConnectionTestView } from '../controller';
import ProviderConnectionTestPanel from './ProviderConnectionTestPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; message?: string; latency?: unknown }) => {
      if (options?.message !== undefined) return String(options.message);
      return options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/enterprise/client/features/admin/users/utils', () => ({
  formatAdminDateTime: () => '2026-01-01',
}));

const pendingView: AiProviderConnectionTestView = {
  canPublish: false,
  stale: false,
  state: {
    errorCategory: null,
    latencyMs: null,
    sanitizedMessage: '',
    stale: false,
    status: 'pending',
    testedAt: new Date('2026-01-01T00:00:00.000Z'),
    testedDraftToken: 'a'.repeat(64),
    testedRevision: 0,
  },
};

const failureView: AiProviderConnectionTestView = {
  canPublish: false,
  stale: false,
  state: {
    errorCategory: 'auth',
    latencyMs: 12,
    sanitizedMessage: 'Connection failed: authentication rejected',
    stale: false,
    status: 'failure',
    testedAt: new Date('2026-01-01T00:00:00.000Z'),
    testedDraftToken: 'a'.repeat(64),
    testedRevision: 0,
  },
};

describe('ProviderConnectionTestPanel', () => {
  it('renders pending without mapping to the failure message', () => {
    render(<ProviderConnectionTestPanel connectionTest={pendingView} />);
    expect(screen.getByText('aiCatalog.editor.test.pending')).toBeTruthy();
    expect(screen.getByText(/Connection test in progress|message\.pending/)).toBeTruthy();
    expect(screen.queryByText('aiCatalog.editor.test.message.failure')).toBeNull();
  });

  it('renders failure message for failed probes', () => {
    render(<ProviderConnectionTestPanel connectionTest={failureView} />);
    expect(screen.getByText('aiCatalog.editor.test.failure')).toBeTruthy();
    expect(screen.getByText('aiCatalog.editor.test.message.failure')).toBeTruthy();
  });
});
