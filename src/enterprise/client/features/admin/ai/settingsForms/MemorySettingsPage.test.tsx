// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySettingsPage from './MemorySettingsPage';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  scope: {
    canWrite: true,
    clearDirtyDraftBlocked: vi.fn(),
    dirtyDraftBlocked: false,
    error: null as unknown,
    isInit: false,
    mappedError: null as null | { code: string; i18nKey: string },
    memory: {},
    mutate: vi.fn(),
    updateMemory: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/hooks/useSaveState', () => ({
  useSaveState: () => ({ isSaving: false, markSaved: vi.fn(), markSaving: vi.fn() }),
}));

vi.mock('@/features/SettingsForms', () => ({
  MemoryFormView: () => <div data-testid="memory-form" />,
}));

vi.mock('@/enterprise/client/features/admin/primitives/AdminPageTemplate', () => ({
  default: ({ children, title }: { children: ReactNode; title: string }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock('./DirtyDraftAlert', () => ({ default: () => null }));

vi.mock('./usePlatformSettingsDefaults', () => ({
  usePlatformSettingsDefaults: () => ({
    ...mocks.scope,
    mutate: mocks.mutate,
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>{children}</MotionProvider>
);

describe('MemorySettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.canWrite = true;
    mocks.scope.dirtyDraftBlocked = false;
    mocks.scope.error = new Error('network');
    mocks.scope.isInit = false;
    mocks.scope.mappedError = null;
    mocks.mutate.mockResolvedValue(undefined);
  });

  it('shows unmapped fetch failure with retry that swallows rejection', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('still down'));
    render(<MemorySettingsPage />, { wrapper });
    expect(screen.getByText('aiMemory.fetchFailed')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'aiMemory.retry' }));
    });
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce());
    // Error state remains visible after rejected retry (no unhandled rejection).
    expect(screen.getByText('aiMemory.fetchFailed')).toBeTruthy();
  });

  it('shows mapped fetch failure codes for retry recovery path', async () => {
    mocks.scope.mappedError = {
      code: 'PLATFORM_PERMISSION_DENIED',
      i18nKey: 'errors.PLATFORM_PERMISSION_DENIED',
    };
    mocks.mutate.mockResolvedValueOnce(undefined);
    render(<MemorySettingsPage />, { wrapper });
    // mapEnterpriseError path: i18n key with stable code as defaultValue.
    expect(screen.getByText('PLATFORM_PERMISSION_DENIED')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'aiMemory.retry' }));
    });
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce());
  });
});
